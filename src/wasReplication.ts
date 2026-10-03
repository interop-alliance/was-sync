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
 * Whether an acked revision is one the server really assigned. A WAS
 * resource's first revision is `1`, so an absent value and `0` both mean the
 * port could not read a revision off the response.
 *
 * @param version {number | undefined}
 * @returns {boolean}
 */
function isRevision(version: number | undefined): version is number {
  return version !== undefined && version > 0
}

/**
 * Builds the push write-back: patches an accepted write's acked server state
 * (`version` / `etag` and/or `metaVersion` / `metaEtag`) into the local row so
 * the next conditional write's `If-Match` echoes what the server last
 * reported. Skips rows that are gone or already current (a tombstoned row is
 * invisible to `findOne` and needs no write-back -- nothing further is pushed
 * for a deleted id). An acked revision of `0` is skipped like an absent one:
 * a WAS resource's first revision is `1`, so `0` is never a real revision.
 * It is the port's fallback for an `ETag` it could not read (hidden from a
 * cross-origin caller) or could not parse a revision out of. Stamping it would
 * overwrite the row's last real revision with a made-up one. A failure is
 * logged at `warn` and swallowed: the write itself succeeded, and a missed
 * write-back only means the acked state is adopted from the change feed's echo
 * on a later pull.
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
      // `0` is never a legitimate revision (a WAS resource starts at `1`); it
      // is the port's fallback for a hidden or unparseable `ETag`.
      if (isRevision(ack.version) && doc.get('version') !== ack.version) {
        patch.version = ack.version
      }
      if (ack.etag !== undefined && doc.get('etag') !== ack.etag) {
        patch.etag = ack.etag
      }
      if (
        isRevision(ack.metaVersion) &&
        doc.get('metaVersion') !== ack.metaVersion
      ) {
        patch.metaVersion = ack.metaVersion
      }
      if (ack.metaEtag !== undefined && doc.get('metaEtag') !== ack.metaEtag) {
        patch.metaEtag = ack.metaEtag
      }
      if (Object.keys(patch).length > 0) {
        await doc.incrementalPatch(patch)
      }
    } catch (err) {
      // Best-effort: the server write was accepted; the revision echo on the
      // next pull corrects the row if this local patch could not be applied.
      log.warn('Could not write the acked revision back into the local row', {
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
 * @param [options.deletedField] {string} RxDB deleted flag (default `_deleted`)
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
  deletedField = '_deleted',
  writerId
}: {
  rxCollection: RxCollection<SyncedDoc>
  wasPort: WasSyncPort
  replicationIdentifier: string
  batchSize?: number
  retryTime?: number
  live?: boolean
  autoStart?: boolean
  deletedField?: string
  writerId?: string
}): RxReplicationState<SyncedDoc, ReplicationCheckpoint> {
  return replicateRxCollection<SyncedDoc, ReplicationCheckpoint>({
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
      handler: createPushHandler({
        port: wasPort,
        onWriteAccepted: createAckWriteBack(rxCollection),
        ...(writerId !== undefined && { writerId })
      }),
      batchSize
    }
  })
}
