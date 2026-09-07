/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The pull side of the WAS replication driver: the `changes`-feed request and
 * response mapping, and the RxDB pull handler built from it. Maps each wire
 * document (`{ id, _deleted, updatedAt, version, metaVersion?, data?, custom?,
 * epoch?, createdBy?, etag?, metaEtag? }`) into an RxDB `WithDeleted<SyncedDoc>`,
 * and applies the empty-page `checkpoint: null` rule.
 */
import type {
  SyncCheckpoint,
  SyncedDoc,
  WasSyncPort,
  WireDoc,
  WithDeleted
} from './types.js'
import { copyOptionalBodyFields } from './types.js'

/**
 * Maps one `changes`-feed wire document into a replica document. The envelope
 * fields map straight across; the content body stays under `data` (omitted for
 * tombstones, which carry no `data`) and the metadata body under `custom`.
 * `metaVersion` / `custom` are present only once metadata has been written for
 * the resource, and are simply absent otherwise (forward-compatible with a
 * server that does not yet surface them on the feed). The server-managed
 * `createdBy` creator DID is carried across on live documents and tombstones
 * alike (it rides the feed on a delete too), and the opaque `epoch` key-epoch id
 * likewise; each is simply absent when the server holds none. The opaque `etag`
 * / `metaEtag` validators are carried across the same way, so a later push can
 * echo one back verbatim as `ifMatch` without a separate re-read. `_deleted`
 * becomes RxDB's native deleted flag.
 *
 * @param doc {WireDoc}
 * @returns {WithDeleted<SyncedDoc>}
 */
export function wireDocToRxDoc(doc: WireDoc): WithDeleted<SyncedDoc> {
  const rxDoc: WithDeleted<SyncedDoc> = {
    id: doc.id,
    updatedAt: doc.updatedAt,
    version: doc.version,
    _deleted: doc._deleted
  }
  copyOptionalBodyFields({ source: doc, target: rxDoc })
  return rxDoc
}

/**
 * Builds the RxDB pull handler that fetches one `changes` page per call and
 * resumes from the previous checkpoint. RxDB passes the last stored checkpoint
 * (`undefined` on the first pull -- which the port omits from the request) and
 * the batch size.
 *
 * The empty-page rule: when the server returns `checkpoint: null` (no change),
 * keep the checkpoint RxDB gave us rather than persisting `null`, so the next
 * pull resumes from the same position instead of restarting the feed. The rule
 * is keyed on the RESPONSE checkpoint being nullish rather than on the page
 * being empty, so a page carrying documents with no checkpoint keeps resuming
 * too.
 *
 * @param port {WasSyncPort}
 * @returns {(lastCheckpoint: SyncCheckpoint | undefined, batchSize: number) =>
 *   Promise<{ documents: WithDeleted<SyncedDoc>[], checkpoint: SyncCheckpoint | undefined }>}
 */
export function createPullHandler(port: WasSyncPort) {
  return async function pull(
    lastCheckpoint: SyncCheckpoint | undefined,
    batchSize: number
  ): Promise<{
    documents: WithDeleted<SyncedDoc>[]
    checkpoint: SyncCheckpoint | undefined
  }> {
    const response = await port.query({
      // Omit `checkpoint` entirely on the first pull (the port sends no
      // checkpoint field, not `null`).
      ...(lastCheckpoint !== undefined && { checkpoint: lastCheckpoint }),
      limit: batchSize
    })
    return {
      documents: response.documents.map(wireDocToRxDoc),
      // Empty page (`checkpoint: null`) means "no change": keep the prior
      // checkpoint so the feed does not restart from the beginning.
      checkpoint: response.checkpoint ?? lastCheckpoint
    }
  }
}
