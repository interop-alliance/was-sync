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
 * - content changed -> `PUT /:id` (`If-Match: "<version>"`) or, on create,
 *   `PUT /:id` (`If-None-Match: *`); a delete -> `DELETE /:id`.
 * - metadata changed -> `PUT /:id/meta` (`If-Match: "<metaVersion>"`, or
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
 * is reported out-of-band: the response ETag of each accepted write is captured
 * and handed to the optional `onWriteAccepted` callback, which writes the acked
 * revision back into the local row (see `createWasReplication`). Without that
 * write-back the local `version` would stay one revision behind the server and
 * every subsequent conditional write would send a stale `If-Match` and 412. The
 * write-back only touches the revision fields (never `data` / `updatedAt`), so
 * the follow-up push cycle it triggers finds nothing changed to write and
 * settles -- no re-push loop.
 */
import {
  formatEtag,
  isSyncAuthError,
  isSyncConflictError,
  isSyncNotFoundError
} from '@interop/was-client/sync'
import type {
  PrimaryReadCache,
  PrimaryState,
  SyncedDoc,
  WasSyncPort,
  WithDeleted
} from './types.js'
import { bodiesEqual, copyOptionalBodyFields } from './types.js'

/**
 * The acked server revisions of one row's accepted writes: the new content
 * `version` (from a `PUT /:id` or `DELETE /:id` response ETag) and/or the new
 * `metaVersion` (from a `PUT /:id/meta` response ETag). Absent fields mean the
 * corresponding write did not run or its response carried no ETag.
 */
export interface PushWriteAck {
  id: string
  version?: number
  metaVersion?: number
}

/**
 * Maps a re-read primary state into the RxDB conflict entry for one row, or --
 * when the re-read found the resource genuinely absent (`primary === null`, a
 * delete/delete race) -- synthesizes the tombstone conflict entry from what we
 * know locally. Shared by the `412` assembler and the `/meta` 404 recovery, so
 * both report an absent primary identically. The primary's `deleted` flag is
 * optional (only a feed-backed read sets it) and an absent one reads as
 * `false`.
 *
 * @param options {object}
 * @param options.id {string}
 * @param options.primary {PrimaryState | null}
 * @param options.fallbackUpdatedAt {string}   used if the resource is now absent
 * @param options.fallbackVersion {number}     used if the resource is now absent
 * @returns {WithDeleted<SyncedDoc>}
 */
function primaryOrTombstone({
  id,
  primary,
  fallbackUpdatedAt,
  fallbackVersion
}: {
  id: string
  primary: PrimaryState | null
  fallbackUpdatedAt: string
  fallbackVersion: number
}): WithDeleted<SyncedDoc> {
  if (primary === null) {
    return {
      id,
      updatedAt: fallbackUpdatedAt,
      version: fallbackVersion,
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
  const isCreate = assumedMasterState === undefined
  const ack: PushWriteAck = { id }
  const hasAck = () =>
    ack.version !== undefined || ack.metaVersion !== undefined
  const fallbackVersion = () =>
    ack.version ?? assumedVersion ?? newDocumentState.version

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

  // Builds the conflict outcome from a re-read primary (or from its absence, a
  // delete/delete race), PRESERVING any ack already earned: a content write
  // accepted before a `/meta` 412 must keep its acked `version` (and feed it to
  // the absent-primary fallback), or the local row keeps the pre-write version
  // and every later conditional write sends a stale `If-Match`.
  const conflictOutcome = (primary: PrimaryState | null) => ({
    conflict: primaryOrTombstone({
      id,
      primary,
      fallbackUpdatedAt: newDocumentState.updatedAt,
      fallbackVersion: fallbackVersion()
    }),
    ack: hasAck() ? ack : null
  })

  // The 412 path: re-read the resource, then report its real primary state.
  const conflictResult = async () => conflictOutcome(await readPrimary())

  // `DELETE /:id` with a `404` read as the already-absent outcome (the
  // header's delete note): the write is reported as accepted with no acked
  // revision. The default port raises the not-found signal; a `mapAuthErrors`
  // port has already resolved `undefined`.
  const deleteAbsentAsDone = async (options: {
    id: string
    ifMatch?: string
  }): Promise<number | undefined> => {
    try {
      return await port.deleteContent(options)
    } catch (err) {
      if (isSyncNotFoundError(err)) {
        return undefined
      }
      throw err
    }
  }

  // Deletes the remote content conditional on the assumed revision, recovering
  // from the one benign `412`: a revision drift with an unchanged body (the
  // header's delete note). A `412` with no assumed revision, an absent primary,
  // or a primary whose body really differs is rethrown, so the caller's conflict
  // path reports it unchanged.
  const deleteWithBenignRetry = async (): Promise<number | undefined> => {
    try {
      return await deleteAbsentAsDone({
        id,
        ...(assumedVersion !== undefined && {
          ifMatch: formatEtag(assumedVersion)
        })
      })
    } catch (err) {
      if (!isSyncConflictError(err) || assumedVersion === undefined) {
        throw err
      }
      const primary = await readPrimary()
      if (
        primary === null ||
        !bodiesEqual(primary.data, assumedMasterState?.data)
      ) {
        throw err
      }
      return await deleteAbsentAsDone({
        id,
        ifMatch: formatEtag(primary.version)
      })
    }
  }

  try {
    if (newDocumentState._deleted) {
      // Delete supersedes any metadata write: drop the content, tombstone wins.
      const ackedVersion = await deleteWithBenignRetry()
      if (ackedVersion !== undefined) {
        ack.version = ackedVersion
      }
      return { conflict: null, ack: ack.version !== undefined ? ack : null }
    }

    // Content half: write on create, or when the content body changed. For a
    // content-addressed collection the update case never fires (an immutable
    // body for a stable id), but it is handled for generality.
    const contentChanged =
      isCreate || !bodiesEqual(newDocumentState.data, assumedMasterState?.data)
    if (contentChanged) {
      const ackedVersion = await port.putContent({
        id,
        data: newDocumentState.data ?? null,
        ...(newDocumentState.epoch !== undefined && {
          epoch: newDocumentState.epoch
        }),
        ...(isCreate
          ? { ifNoneMatch: true }
          : assumedVersion !== undefined && {
              ifMatch: formatEtag(assumedVersion)
            })
      })
      if (ackedVersion !== undefined) {
        ack.version = ackedVersion
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
      const assumedMetaVersion = assumedMasterState?.metaVersion
      const ackedMetaVersion = await port.putMeta({
        id,
        ...(newDocumentState.custom !== undefined && {
          custom: newDocumentState.custom
        }),
        ...(assumedMetaVersion !== undefined
          ? { ifMatch: formatEtag(assumedMetaVersion) }
          : { ifNoneMatch: true })
      })
      if (ackedMetaVersion !== undefined) {
        ack.metaVersion = ackedMetaVersion
      }
    } catch (err) {
      if (isSyncConflictError(err)) {
        return await conflictResult()
      }
      // Corroborate before condemnation: under WAS 404-masking a `/meta` 404
      // is ambiguous -- expired access, or an ordinary race with a remote
      // delete (a PUT to the `/meta` of a nonexistent resource legitimately
      // 404s). An independent request decides: re-read the primary off the
      // changes feed. A feed read that is itself denied rethrows its own auth
      // error (access genuinely expired, so the controller escalates); a feed
      // that answers with an absent/deleted primary confirms the delete race,
      // and the row is resolved with that tombstone as the conflict entry
      // (the conflict handler reconciles it) instead of flipping the whole
      // session to "access expired" and wedging the batch in RxDB's retries.
      if (
        isSyncAuthError(err) &&
        (err as { status?: unknown }).status === 404
      ) {
        const primary = await readPrimary()
        if (primary === null || primary.deleted) {
          return conflictOutcome(primary)
        }
        // The resource is alive and readable while its `/meta` write 404s:
        // the write itself was rejected, so the auth signal stands.
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
