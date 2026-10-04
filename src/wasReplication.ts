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
import type { ReplicationCheckpoint, SyncedDoc, WasSyncPort } from './types.js'
import { createPullHandler } from './changesQuery.js'
import { createPushHandler, type PushWriteAck } from './pushWrites.js'
import { log } from './log.js'

/**
 * Builds the push write-back: patches an accepted write's acked validators
 * (`etag` and/or `metaEtag`) into the local row so the next conditional write's
 * `If-Match` echoes what the server last reported. Skips rows that are gone or
 * already current (a tombstoned row is invisible to `findOne` and needs no
 * write-back -- nothing further is pushed for a deleted id). Nothing else is
 * patched: the ack carries no stamp, so the write's stamp reaches the row from
 * the feed's echo or a conflict entry (an ack that does carry one patches it
 * as a unit beside its validator, the content ack the top-level triple and the
 * `/meta` ack `meta`). A failure is logged at `warn` and swallowed: the write
 * itself succeeded, and a missed write-back only means the acked state is
 * adopted from the change feed's echo on a later pull.
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
      const patch: Partial<SyncedDoc> = {}
      if (ack.etag !== undefined && doc.get('etag') !== ack.etag) {
        patch.etag = ack.etag
      }
      if (ack.metaEtag !== undefined && doc.get('metaEtag') !== ack.metaEtag) {
        patch.metaEtag = ack.metaEtag
      }
      if (Object.keys(patch).length > 0) {
        await doc.incrementalPatch(patch)
      }
    } catch (err) {
      // Best-effort: the server write was accepted; the feed's echo on the
      // next pull corrects the row if this local patch could not be applied.
      log.warn('Could not write the acked validator back into the local row', {
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
 *   delete declares it as the `Writer-Id` header and every metadata write as
 *   the body's `writerId` member. When absent, pushes declare no label, which
 *   clears any stored one under the server's declare-or-clear rule. A session
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
