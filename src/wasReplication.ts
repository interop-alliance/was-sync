/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * `createWasReplication` -- wires an RxDB collection to a remote WAS Collection
 * through the collection-agnostic pull/push handlers. This is the driver's own
 * entry point; the caller supplies an already-open RxDB
 * collection and a {@link WasSyncPort} (its only WAS dependency), and gets back
 * the live `RxReplicationState` to observe (`error$` / `active$`) and control
 * (`reSync()` / `cancel()`).
 *
 * No React imports -- only RxDB (the replication engine being wrapped) and the
 * injected port. This is the seam that keeps the WAS access injectable.
 */
import {
  replicateRxCollection,
  type RxReplicationState
} from 'rxdb/plugins/replication'
import type { RxCollection } from 'rxdb/plugins/core'
import { isMetaStamp, isWriteStamp } from '@interop/was-client/sync'
import type { ReplicationCheckpoint, SyncedDoc, WasSyncPort } from './types.js'
import { bodiesEqual } from './types.js'
import { statesEqual } from './conflictHandler.js'
import { syncedDocSchema } from './syncedDocSchema.js'
import { createPullHandler } from './changesQuery.js'
import { createPushHandler, type PushWriteAck } from './pushWrites.js'
import { log } from './log.js'

const schemaProperties: Record<string, unknown> = syncedDocSchema().properties
const metaProperties: Record<string, unknown> =
  (schemaProperties.meta as { properties?: Record<string, unknown> })
    .properties ?? {}

/**
 * Whether every string member of an acked record fits the `maxLength` its
 * schema property declares, so a patch carrying it cannot be refused by a
 * validating storage and lose the validators patched beside it. A member with
 * no bound fits anything; the first member that does not fit is logged at
 * `debug`.
 *
 * @param options {object}
 * @param options.id {string}   the row, for the log entry
 * @param options.members {object}   the acked members, by schema property name
 * @param [options.properties] {Record<string, unknown>}   the schema
 *   properties to check against; the top-level ones by default
 * @returns {boolean}
 */
function fitsSchema({
  id,
  members,
  properties = schemaProperties
}: {
  id: string
  members: object
  properties?: Record<string, unknown>
}): boolean {
  for (const [member, value] of Object.entries(members)) {
    const bound = (properties[member] as { maxLength?: unknown } | undefined)
      ?.maxLength
    if (
      typeof value === 'string' &&
      typeof bound === 'number' &&
      value.length > bound
    ) {
      log.debug('Acked member exceeds the schema bound; not patched', {
        id,
        member
      })
      return false
    }
  }
  return true
}

/**
 * Copies onto `patch` each member of `candidate` the row does not already
 * hold, so a row that is already current gets no patch and no follow-up push
 * cycle.
 *
 * @param options {object}
 * @param options.patch {Record<string, unknown>}
 * @param options.current {SyncedDoc}   the row as stored
 * @param options.candidate {Partial<SyncedDoc>}   the acked members
 */
function assignDiffering({
  patch,
  current,
  candidate
}: {
  patch: Record<string, unknown>
  current: SyncedDoc
  candidate: Partial<SyncedDoc>
}): void {
  for (const [member, value] of Object.entries(candidate)) {
    if (!bodiesEqual(current[member as keyof SyncedDoc], value)) {
      patch[member] = value
    }
  }
}

/**
 * Builds the push write-back: patches an accepted write's acked state into the
 * local row so the next conditional write's `If-Match` echoes what the server
 * last reported, and so the row holds what the server assigned without waiting
 * for the feed echo. Skips rows that are gone or already current (a tombstoned
 * row is invisible to `findOne` and needs no write-back -- nothing further is
 * pushed for a deleted id).
 *
 * The validators (`etag` from the content ack, `metaEtag` from the `/meta`
 * ack) are patched whenever present. The stamp members ride beside them under
 * three conditions. A member is patched only from an ack that also carries a
 * validator: a hidden-`ETag` deployment, where the echo has to land anyway,
 * gets no write-back it did not have. Each stamp is patched as a unit: the
 * content ack supplies the top-level triple and `createdBy`, the `/meta` ack
 * supplies `meta`, and the two are not mixed, so the `/meta` ack's own copy of
 * the content stamp is ignored. And the content stamp is patched only while
 * the row still holds the state that was pushed ({@link statesEqual}), so a
 * local edit made during the push keeps its own stamp even when the edit left
 * `updatedAt` alone (the validators are patched regardless). A member longer
 * than the schema allows is skipped at `debug`, so the single patch cannot
 * throw on it. Everything lands in one `incrementalPatch`.
 *
 * A failure is logged at `warn` and swallowed: the write itself succeeded, and
 * a missed write-back only means the acked state is adopted from the change
 * feed's echo on a later pull.
 *
 * @param rxCollection {RxCollection<SyncedDoc>}
 * @returns {(ack: PushWriteAck) => Promise<void>}
 */
function createAckWriteBack(rxCollection: RxCollection<SyncedDoc>) {
  return async function writeBack(ack: PushWriteAck): Promise<void> {
    try {
      const doc = await rxCollection.findOne(ack.id).exec()
      if (doc === null) {
        return
      }
      const { id, content, meta } = ack
      // A read-only snapshot, compared and never mutated.
      const current = doc.toJSON() as SyncedDoc
      const patch: Record<string, unknown> = {}
      if (content?.etag !== undefined) {
        const { etag, createdBy } = content
        const candidate: Partial<SyncedDoc> = { etag }
        // The stamp is patched whole or not at all; a partial one is left out.
        // `toJSON()` strips `_deleted`; a row `findOne` returned is live.
        if (
          isWriteStamp(content) &&
          statesEqual({ ...current, _deleted: false }, ack.pushedState)
        ) {
          const { updatedAt, updatedAtCounter, originId } = content
          const stamp = { updatedAt, updatedAtCounter, originId }
          if (fitsSchema({ id, members: stamp })) {
            Object.assign(candidate, stamp)
          }
        }
        if (
          createdBy !== undefined &&
          fitsSchema({ id, members: { createdBy } })
        ) {
          candidate.createdBy = createdBy
        }
        assignDiffering({ patch, current, candidate })
      }
      if (meta?.etag !== undefined) {
        const candidate: Partial<SyncedDoc> = { metaEtag: meta.etag }
        if (
          isMetaStamp(meta.meta) &&
          fitsSchema({ id, members: meta.meta, properties: metaProperties })
        ) {
          candidate.meta = meta.meta
        }
        assignDiffering({ patch, current, candidate })
      }
      if (Object.keys(patch).length > 0) {
        await doc.incrementalPatch(patch)
      }
    } catch (err) {
      // Best-effort: the server write was accepted; the feed's echo on the
      // next pull corrects the row if this local patch could not be applied.
      log.warn('Could not write the acked state back into the local row', {
        id: ack.id,
        err
      })
    }
  }
}

/**
 * Starts (or configures) replication of one RxDB collection against a remote WAS
 * Collection. Poll-based only -- no `pull.stream$` (live streaming is deferred
 * server-side); RxDB's own `retryTime` backoff and `error$` are the reachability
 * signal (the replication attempt is the probe).
 *
 * @param options {object}
 * @param options.rxCollection {RxCollection<SyncedDoc>}   the local replica
 * @param options.wasPort {WasSyncPort}                    injected WAS access
 * @param options.replicationIdentifier {string}   stable id (include the server
 *   URL + collection) so RxDB can resume across reloads
 * @param [options.batchSize] {number}    pull `limit` / push batch (default 100)
 * @param [options.retryTime] {number}    ms backoff between failed cycles
 * @param [options.live] {boolean}        ongoing (default true) vs one-shot
 * @param [options.autoStart] {boolean}   start immediately (default true)
 * @param [options.writerId] {string}    this replica's writer-attribution
 *   label (the WAS `writerId`), minted and kept app-side. The driver never
 *   mints, persists, or derives one. When present, every content write and
 *   delete declares it as the `Writer-Id` header; a metadata write sends none,
 *   since the label is a member of the content record alone. When absent,
 *   pushes declare no label, which clears any stored one under the server's
 *   declare-or-clear rule. A session
 *   that must not reveal a stable label to the host leaves it absent or passes
 *   a per-session one. The pull side does not read it: the pull handler
 *   decrypts nothing (bodies are opaque), so a replica's own echo has no
 *   decrypt to skip, and RxDB writes a pulled state into the local row only
 *   where the collection's `isEqual` says it differs.
 * @returns {RxReplicationState<SyncedDoc, ReplicationCheckpoint>}
 */
export function createWasReplication({
  rxCollection,
  wasPort,
  replicationIdentifier,
  batchSize = 100,
  retryTime,
  live = true,
  autoStart = true,
  writerId
}: {
  rxCollection: RxCollection<SyncedDoc>
  wasPort: WasSyncPort
  replicationIdentifier: string
  batchSize?: number
  retryTime?: number
  live?: boolean
  autoStart?: boolean
  writerId?: string
}): RxReplicationState<SyncedDoc, ReplicationCheckpoint> {
  return replicateRxCollection<SyncedDoc, ReplicationCheckpoint>({
    replicationIdentifier,
    collection: rxCollection,
    // The driver reads and writes `_deleted` everywhere (push rows, conflict
    // entries, the feed primary read), so RxDB's default `deletedField` is the
    // only one it can run under; the option is not exposed.
    live,
    autoStart,
    ...(retryTime !== undefined && { retryTime }),
    pull: {
      handler: createPullHandler(wasPort),
      batchSize
    },
    push: {
      handler: createPushHandler({
        port: wasPort,
        onWriteAccepted: createAckWriteBack(rxCollection),
        ...(writerId !== undefined && { writerId })
      }),
      batchSize
    }
  })
}
