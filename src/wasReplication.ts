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
import type { SyncCheckpoint, SyncedDoc, WasSyncPort } from './types.js'
import { createPullHandler } from './changesQuery.js'
import { createPushHandler, type PushWriteAck } from './pushWrites.js'

/**
 * Builds the push write-back: patches an accepted write's acked server
 * revision(s) (`version` / `metaVersion`) into the local row so the next
 * conditional write's `If-Match` matches the server. Skips rows that are gone
 * or already current (a tombstoned row is invisible to `findOne` and needs no
 * write-back -- nothing further is pushed for a deleted id). Failures are
 * swallowed: the write itself succeeded, and a missed write-back only means
 * the acked revision is adopted from the change feed's echo on a later pull.
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
      if (ack.version !== undefined && doc.get('version') !== ack.version) {
        patch.version = ack.version
      }
      if (
        ack.metaVersion !== undefined &&
        doc.get('metaVersion') !== ack.metaVersion
      ) {
        patch.metaVersion = ack.metaVersion
      }
      if (Object.keys(patch).length > 0) {
        await doc.incrementalPatch(patch)
      }
    } catch {
      // Best-effort: the server write was accepted; the revision echo on the
      // next pull corrects the row if this local patch could not be applied.
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
 * @param [options.deletedField] {string} RxDB deleted flag (default `_deleted`)
 * @returns {RxReplicationState<SyncedDoc, SyncCheckpoint>}
 */
export function createWasReplication({
  rxCollection,
  wasPort,
  replicationIdentifier,
  batchSize = 100,
  retryTime,
  live = true,
  autoStart = true,
  deletedField = '_deleted'
}: {
  rxCollection: RxCollection<SyncedDoc>
  wasPort: WasSyncPort
  replicationIdentifier: string
  batchSize?: number
  retryTime?: number
  live?: boolean
  autoStart?: boolean
  deletedField?: string
}): RxReplicationState<SyncedDoc, SyncCheckpoint> {
  return replicateRxCollection<SyncedDoc, SyncCheckpoint>({
    replicationIdentifier,
    collection: rxCollection,
    deletedField,
    live,
    autoStart,
    ...(retryTime !== undefined && { retryTime }),
    pull: {
      handler: createPullHandler(wasPort),
      batchSize
    },
    push: {
      handler: createPushHandler(wasPort, createAckWriteBack(rxCollection)),
      batchSize
    }
  })
}
