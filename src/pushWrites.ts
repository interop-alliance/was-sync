/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The push side of the WAS replication adapter: fans each local change out to
 * conditional WAS writes and assembles the RxDB conflict entry when the server
 * rejects a write with `412`.
 *
 * A single RxDB document spans two independently-versioned sub-resources: the
 * content (`data` / `version`, at `PUT/DELETE /:id`) and the metadata (`custom`
 * / `metaVersion`, at `PUT /:id/meta`). This handler diffs the new local state
 * against the assumed primary to route each half:
 *
 * - content changed -> `PUT /:id` (`If-Match: <etag>`, the opaque validator
 *   the assumed primary last reported) or, on create, `PUT /:id`
 *   (`If-None-Match: *`); a delete -> `DELETE /:id`.
 * - metadata changed -> `PUT /:id/meta` (`If-Match: <metaEtag>`, or
 *   `If-None-Match: *` when the resource has no metadata yet); a metadata
 *   CLEAR (the new state carries no `custom`) writes the cleared state rather
 *   than being skipped.
 *
 * Content is written before metadata on a create, because the server rejects a
 * `/meta` write to a resource that does not yet exist.
 *
 * A delete carries one recovery of its own: the benign `412`. A locally created
 * row is pushed with the revision it was inserted with while the server assigns
 * its own, so until that write is acked (or echoes back on a pull) the assumed
 * revision can lag the resource's real ETag, and a delete conditional on the
 * stale revision would be refused forever, leaving the resource live on the
 * server. So a refused delete re-reads the primary, and a primary whose body is
 * unchanged is the same content under a drifted revision: the delete is
 * re-issued against the fresh ETag. Every other `412` is a real conflict.
 *
 * A `412` whose re-read resolves `null` is reported as a tombstone conflict
 * entry with no `etag` and `version: 0`, the value a fresh local row carries
 * for "no server revision known". The plain was-client port resolves `null` for
 * a tombstone and for a resource that never existed alike (a `GET` on either
 * is a `404`), and the two cases take the same next write, so the entry does
 * not tell them apart. A server treats a tombstone as absent for preconditions:
 * `If-None-Match: *` re-creates it while `If-Match` against it is refused
 * whatever validator is sent. So an assumed primary that is a tombstone (that
 * conflict entry once RxDB has adopted it, or a tombstone pulled off the feed)
 * routes a content write to the create path and a delete to an unconditional
 * `DELETE`, which a conformant server answers `204` for. Without that routing
 * the re-push after a resurrect-vs-remote-delete conflict either sent
 * `If-Match` with a fabricated revision and looped, or sent an unconditional
 * `PUT` that could overwrite a concurrent re-create.
 *
 * A delete's `404` is read as the already-absent outcome rather than an error.
 * A spec-conformant server answers `204` for an authorized delete of a resource
 * it does not hold (a row deleted locally before its create ever landed, or one
 * another replica deleted first), so a `404` on this path is either a server
 * that does not treat delete as idempotent or WAS's masked authorization
 * refusal. Either way the tombstone's goal state cannot be advanced by a retry:
 * a rethrow would reject the whole batch and RxDB would re-send it unchanged
 * forever, so no other row in the batch could reach the server. was-client's
 * port already resolves the `404` itself under `mapAuthErrors`; on the default
 * port it raises the not-found signal, and this handler reads both the same
 * way. Revoked access still surfaces on the next feed pull.
 *
 * RxDB's push contract asks only for *conflicts* back (the current primary state
 * of each rejected row), so a successful write's new `version` / `metaVersion`
 * (and the opaque `etag` / `metaEtag` validators behind them) is reported
 * out-of-band: each accepted write's {@link WriteAck} is captured and handed to
 * the optional `onWriteAccepted` callback, which writes the acked state back
 * into the local row (see `createWasReplication`). Without that write-back the
 * local row would stay one revision behind the server and every subsequent
 * conditional write would send a stale `If-Match` and 412. The write-back only
 * touches the revision/etag fields (never `data` / `updatedAt`), so the
 * follow-up push cycle it triggers finds nothing changed to write and settles
 * -- no re-push loop.
 */
import {
  isSyncAuthError,
  isSyncConflictError,
  isSyncNotFoundError
} from '@interop/was-client/sync'
import type {
  PrimaryReadCache,
  PrimaryState,
  SyncedDoc,
  WasSyncPort,
  WithDeleted,
  WriteAck
} from './types.js'
import { bodiesEqual, copyOptionalBodyFields } from './types.js'
import { log } from './log.js'

/**
 * Whether a `/meta` write's rejection is the not-found shape on either port
 * configuration: the default port's not-found signal, or the `mapAuthErrors`
 * port's auth signal carrying the masked `404`. One classifier for both, so
 * the recovery below cannot be reachable on one port and not the other. Both
 * are name matches (invariant 5).
 *
 * @param err {unknown}
 * @returns {boolean}
 */
function isMetaNotFound(err: unknown): boolean {
  return (
    isSyncNotFoundError(err) ||
    (isSyncAuthError(err) && (err as { status?: unknown }).status === 404)
  )
}

/**
 * The acked server state of one row's accepted writes: the new content
 * `version` / `etag` (from a `PUT /:id` or `DELETE /:id`) and/or the new
 * `metaVersion` / `metaEtag` (from a `PUT /:id/meta`). Absent fields mean the
 * corresponding write did not run or its response carried no `ETag`. `etag` /
 * `metaEtag` are opaque -- echo them back verbatim as a later write's
 * `ifMatch` rather than reformatting `version` / `metaVersion`.
 */
export interface PushWriteAck {
  id: string
  version?: number
  etag?: string
  metaVersion?: number
  metaEtag?: string
}

/**
 * Maps a re-read primary state into the RxDB conflict entry for one row, or --
 * when the re-read resolved `null` (a tombstone, or a resource that never
 * existed; the plain port reports both that way) -- the tombstone conflict
 * entry. That entry carries no `etag` and `version: 0`, since the server's
 * revision is unknown and nothing local stands in for it; the local `updatedAt`
 * fills the required sort field. Shared by the `412` assembler and the `/meta`
 * 404 recovery, so both report an absent primary identically. The primary's
 * `deleted` flag is optional (only a feed-backed read sets it) and an absent
 * one reads as `false`.
 *
 * @param options {object}
 * @param options.id {string}
 * @param options.primary {PrimaryState | null}
 * @param options.fallbackUpdatedAt {string}   used if the resource is now absent
 * @returns {WithDeleted<SyncedDoc>}
 */
function primaryOrTombstone({
  id,
  primary,
  fallbackUpdatedAt
}: {
  id: string
  primary: PrimaryState | null
  fallbackUpdatedAt: string
}): WithDeleted<SyncedDoc> {
  if (primary === null) {
    return {
      id,
      updatedAt: fallbackUpdatedAt,
      version: 0,
      _deleted: true
    }
  }
  const conflict: WithDeleted<SyncedDoc> = {
    id,
    updatedAt: primary.updatedAt,
    version: primary.version,
    // An absent `deleted` is a live resource: a port whose `get` resolves
    // `null` for a tombstone (the client's own read) never sets the member,
    // and the `primary === null` branch above is that port's tombstone.
    _deleted: primary.deleted ?? false
  }
  copyOptionalBodyFields({ source: primary, target: conflict })
  return conflict
}

/**
 * Sends one local change to the remote Collection as up to two conditional
 * writes (content, then metadata). Returns the primary-state conflict entry on a
 * `412` at either step, or the accepted writes' acked revisions on success
 * (`ack: null` when no response carried a revision). A conflict on the
 * metadata half still returns the content half's earned ack alongside the
 * conflict entry, so an accepted content version is never discarded.
 *
 * @param options {object}
 * @param options.port {WasSyncPort}
 * @param options.newDocumentState {WithDeleted<SyncedDoc>}
 * @param [options.assumedMasterState] {WithDeleted<SyncedDoc>}
 * @param [options.cache] {PrimaryReadCache}   the push batch's shared
 *   primary-read memo
 * @returns {Promise<{ conflict: WithDeleted<SyncedDoc> | null,
 *   ack: PushWriteAck | null }>}
 */
async function pushRow({
  port,
  newDocumentState,
  assumedMasterState,
  cache
}: {
  port: WasSyncPort
  newDocumentState: WithDeleted<SyncedDoc>
  assumedMasterState?: WithDeleted<SyncedDoc>
  cache?: PrimaryReadCache
}): Promise<{
  conflict: WithDeleted<SyncedDoc> | null
  ack: PushWriteAck | null
}> {
  const { id } = newDocumentState
  const assumedVersion = assumedMasterState?.version
  const assumedEtag = assumedMasterState?.etag
  const assumedMetaVersion = assumedMasterState?.metaVersion
  const assumedMetaEtag = assumedMasterState?.metaEtag
  // An assumed primary that is a tombstone holds no live resource to condition
  // on (the header's tombstone note): a content write is a create and a delete
  // goes unconditional, whatever validator the tombstone carries.
  const assumedIsTombstone = assumedMasterState?._deleted === true
  const isCreate = assumedMasterState === undefined || assumedIsTombstone
  const deleteEtag = assumedIsTombstone ? undefined : assumedEtag
  const ack: PushWriteAck = { id }
  const hasAck = () =>
    ack.version !== undefined || ack.metaVersion !== undefined

  // Re-reads this row's primary. A row that has ALREADY written this batch
  // (a content write accepted before a `/meta` rejection) bypasses the batch
  // memo: a sibling's feed read may have paged past this resource before our
  // own write landed, and the conflict entry must carry the revision that write
  // produced. Rows that wrote nothing -- the ordinary content 412, the common
  // case -- are exactly what the memo is for. On a feed-backed primary read the
  // memo can hold a version a sibling row's walk recorded before this row's
  // delete was attempted; a retry built on it can 412 again, and that second
  // 412 falls to the ordinary conflict path, so it converges a cycle later.
  const readPrimary = async (): Promise<PrimaryState | null> =>
    hasAck()
      ? port.get({ id })
      : port.get({ id, ...(cache !== undefined && { cache }) })

  // Builds the conflict outcome from a re-read primary (or from its absence),
  // PRESERVING any ack already earned: a content write accepted before a
  // `/meta` 412 must keep its acked `version` / `etag`, or the local row keeps
  // the pre-write state and every later conditional write sends a stale
  // `If-Match`.
  const conflictOutcome = (primary: PrimaryState | null) => ({
    conflict: primaryOrTombstone({
      id,
      primary,
      fallbackUpdatedAt: newDocumentState.updatedAt
    }),
    ack: hasAck() ? ack : null
  })

  // The 412 path: re-read the resource, then report its real primary state.
  const conflictResult = async () => {
    const outcome = conflictOutcome(await readPrimary())
    log.debug('Write refused; handing the conflict entry to RxDB', {
      id,
      assumedVersion,
      version: outcome.conflict.version,
      deleted: outcome.conflict._deleted
    })
    return outcome
  }

  // `DELETE /:id` with a `404` read as the already-absent outcome (the
  // header's delete note): the write is reported as accepted with no acked
  // revision. The default port raises the not-found signal; a `mapAuthErrors`
  // port has already resolved `undefined`.
  const deleteAbsentAsDone = async (options: {
    id: string
    ifMatch?: string
  }): Promise<WriteAck | undefined> => {
    try {
      return await port.deleteContent(options)
    } catch (err) {
      if (isSyncNotFoundError(err)) {
        return undefined
      }
      throw err
    }
  }

  // Deletes the remote content conditional on the assumed etag (none when the
  // assumed primary is a tombstone), recovering from the one benign `412`: a
  // revision drift with an unchanged body (the header's delete note). A `412`
  // with no assumed etag, an absent primary, or a primary whose body really
  // differs is rethrown, so the caller's conflict path reports it unchanged.
  const deleteWithBenignRetry = async (): Promise<WriteAck | undefined> => {
    try {
      return await deleteAbsentAsDone({
        id,
        ...(deleteEtag !== undefined && { ifMatch: deleteEtag })
      })
    } catch (err) {
      if (!isSyncConflictError(err) || deleteEtag === undefined) {
        throw err
      }
      const primary = await readPrimary()
      if (
        primary === null ||
        !bodiesEqual(primary.data, assumedMasterState?.data)
      ) {
        throw err
      }
      log.debug('Delete refused on a drifted revision; re-issuing it', {
        id,
        assumedVersion,
        version: primary.version
      })
      return await deleteAbsentAsDone({
        id,
        ...(primary.etag !== undefined && { ifMatch: primary.etag })
      })
    }
  }

  try {
    if (newDocumentState._deleted) {
      // Delete supersedes any metadata write: drop the content, tombstone wins.
      const ackedDelete = await deleteWithBenignRetry()
      if (ackedDelete !== undefined) {
        ack.version = ackedDelete.version
        if (ackedDelete.etag !== undefined) {
          ack.etag = ackedDelete.etag
        }
      }
      return { conflict: null, ack: ack.version !== undefined ? ack : null }
    }

    // Content half: write on create, or when the content body changed. For a
    // content-addressed collection the update case never fires (an immutable
    // body for a stable id), but it is handled for generality.
    const contentChanged =
      isCreate || !bodiesEqual(newDocumentState.data, assumedMasterState?.data)
    if (contentChanged) {
      const ackedContent = await port.putContent({
        id,
        data: newDocumentState.data ?? null,
        ...(newDocumentState.epoch !== undefined && {
          epoch: newDocumentState.epoch
        }),
        ...(isCreate
          ? { ifNoneMatch: true }
          : assumedEtag !== undefined && { ifMatch: assumedEtag })
      })
      ack.version = ackedContent.version
      if (ackedContent.etag !== undefined) {
        ack.etag = ackedContent.etag
      }
    }
  } catch (err) {
    if (isSyncConflictError(err)) {
      return await conflictResult()
    }
    // Any non-conflict error (network, 5xx, auth) propagates so RxDB retries
    // the whole batch with backoff.
    throw err
  }

  // Metadata half: write when the metadata changed -- including a CLEAR (the
  // new state carries no `custom` while the assumed primary does; `putMeta`
  // with no `custom` writes the cleared state). On a create this runs after
  // the content write (the resource must exist first). Its own try/catch so a
  // rejection here can never discard an ack the content half already earned.
  const metadataChanged = !bodiesEqual(
    newDocumentState.custom,
    assumedMasterState?.custom
  )
  if (metadataChanged) {
    try {
      const ackedMeta = await port.putMeta({
        id,
        ...(newDocumentState.custom !== undefined && {
          custom: newDocumentState.custom
        }),
        ...(assumedMetaVersion !== undefined
          ? assumedMetaEtag !== undefined && { ifMatch: assumedMetaEtag }
          : { ifNoneMatch: true })
      })
      if (ackedMeta !== undefined) {
        ack.metaVersion = ackedMeta.version
        if (ackedMeta.etag !== undefined) {
          ack.metaEtag = ackedMeta.etag
        }
      }
    } catch (err) {
      if (isSyncConflictError(err)) {
        return await conflictResult()
      }
      // Corroborate before condemnation: under WAS 404-masking a `/meta` 404
      // is ambiguous -- expired access, or an ordinary race with a remote
      // delete (a PUT to the `/meta` of a nonexistent resource legitimately
      // 404s). The default port raises it as the not-found signal, a
      // `mapAuthErrors` port as the auth signal with `status: 404`; both take
      // this path. An independent request decides: re-read the primary off
      // the changes feed. A feed read that is itself denied rethrows its own
      // auth error (access genuinely expired, so the controller escalates); a
      // feed that answers with an absent/deleted primary confirms the delete
      // race, and the row is resolved with that tombstone as the conflict
      // entry (the conflict handler reconciles it) instead of rejecting the
      // batch -- which would wedge it in RxDB's retries, or on the auth port
      // flip the whole session to "access expired".
      if (isMetaNotFound(err)) {
        const primary = await readPrimary()
        if (primary === null || primary.deleted) {
          return conflictOutcome(primary)
        }
        // The resource is alive and readable while its `/meta` write 404s:
        // the write itself was rejected, so the original signal stands.
      }
      throw err
    }
  }

  return { conflict: null, ack: hasAck() ? ack : null }
}

/**
 * Builds the RxDB push handler that fans a batch of local changes out to
 * conditional WAS writes and returns the conflicting rows' primary states.
 *
 * Rows are pushed concurrently; if any non-conflict error is thrown the whole
 * batch rejects (RxDB re-sends it later), matching RxDB's all-or-nothing retry.
 *
 * Each accepted write's acked server revision(s) are handed to
 * `onWriteAccepted` (when supplied) as soon as that row's writes settle, so the
 * caller can write the new `version` / `metaVersion` back into the local row
 * and keep subsequent conditional writes' `If-Match` in step with the server.
 *
 * Each batch gets one short-lived primary-read memo, shared by its rows and
 * discarded with the batch (never held across batches, where it would go
 * stale). A conflict re-read walks the changes feed from its origin and so pages
 * past every other conflicting row's primary on the way; without the memo a batch
 * with k conflicts would run k concurrent full-feed walks.
 *
 * @param port {WasSyncPort}
 * @param [onWriteAccepted] {(ack: PushWriteAck) => Promise<void>}
 * @returns {(rows: Array<{ newDocumentState: WithDeleted<SyncedDoc>,
 *   assumedMasterState?: WithDeleted<SyncedDoc> }>) =>
 *   Promise<WithDeleted<SyncedDoc>[]>}
 */
export function createPushHandler(
  port: WasSyncPort,
  onWriteAccepted?: (ack: PushWriteAck) => Promise<void>
) {
  return async function push(
    rows: Array<{
      newDocumentState: WithDeleted<SyncedDoc>
      assumedMasterState?: WithDeleted<SyncedDoc>
    }>
  ): Promise<WithDeleted<SyncedDoc>[]> {
    const cache: PrimaryReadCache = { byId: new Map(), inFlight: null }
    const results = await Promise.all(
      rows.map(async row => {
        const result = await pushRow({
          port,
          newDocumentState: row.newDocumentState,
          assumedMasterState: row.assumedMasterState,
          cache
        })
        if (result.ack !== null && onWriteAccepted !== undefined) {
          await onWriteAccepted(result.ack)
        }
        return result
      })
    )
    return results
      .map(result => result.conflict)
      .filter(
        (conflict): conflict is WithDeleted<SyncedDoc> => conflict !== null
      )
  }
}
