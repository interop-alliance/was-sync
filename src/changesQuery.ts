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
import { isSyncCheckpointError } from '@interop/was-client/sync'
import type {
  ReplicationCheckpoint,
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
 * becomes RxDB's native deleted flag. The feed's `writerId` label is not
 * carried across: the replica schema has no member for it, so a labeled and an
 * unlabeled revision map to the same row.
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
 * resumes from the previous checkpoint. RxDB passes the last stored
 * {@link ReplicationCheckpoint} (`undefined` on the first pull) and the batch
 * size; the handler unwraps the opaque string for the port, which omits an
 * absent checkpoint from the request, and wraps the page's checkpoint for
 * RxDB on the way back.
 *
 * The empty-page rule: when the server returns `checkpoint: null` (no change),
 * keep the checkpoint RxDB gave us rather than persisting `null`, so the next
 * pull resumes from the same position instead of restarting the feed. The rule
 * is keyed on the RESPONSE checkpoint being nullish rather than on the page
 * being empty, so a page carrying documents with no checkpoint keeps resuming
 * too.
 *
 * The checkpoint is opaque, passed back verbatim. A server refuses a
 * checkpoint it did not issue (a replica created against another server), and
 * the port raises that as its refused-checkpoint signal (matched by
 * `isSyncCheckpointError`). The handler then pulls again from the beginning, which is safe because the apply path is keyed by
 * resource id. RxDB persists a checkpoint only with a non-empty page, so when
 * the restarted feed is empty the refused checkpoint stays stored and RxDB
 * offers it again on the next poll; the handler remembers the refusal and
 * skips straight to the restart, so the 400 round trip is paid once per
 * process rather than once per poll.
 *
 * @param port {WasSyncPort}
 * @returns {(lastCheckpoint: ReplicationCheckpoint | undefined, batchSize: number) =>
 *   Promise<{ documents: WithDeleted<SyncedDoc>[], checkpoint: ReplicationCheckpoint | undefined }>}
 */
export function createPullHandler(port: WasSyncPort) {
  let refused: SyncCheckpoint | undefined
  return async function pull(
    lastCheckpoint: ReplicationCheckpoint | undefined,
    batchSize: number
  ): Promise<{
    documents: WithDeleted<SyncedDoc>[]
    checkpoint: ReplicationCheckpoint | undefined
  }> {
    // Omit `checkpoint` entirely when there is none to resume from (the port
    // sends no checkpoint field, not `null`).
    const fetchPage = (checkpoint?: SyncCheckpoint) =>
      port.query({
        ...(checkpoint !== undefined && { checkpoint }),
        limit: batchSize
      })
    let resumeFrom = lastCheckpoint?.checkpoint
    if (resumeFrom === refused) {
      resumeFrom = undefined
    }
    let response
    try {
      response = await fetchPage(resumeFrom)
    } catch (err) {
      if (resumeFrom === undefined || !isSyncCheckpointError(err)) {
        throw err
      }
      // The server did not issue this checkpoint: restart the feed, and do
      // not hand the refused checkpoint back should the restarted page be
      // empty.
      refused = resumeFrom
      resumeFrom = undefined
      response = await fetchPage()
    }
    // Empty page (`checkpoint: null`) means "no change": keep the prior
    // checkpoint so the feed does not restart from the beginning.
    const next = response.checkpoint ?? resumeFrom
    return {
      documents: response.documents.map(wireDocToRxDoc),
      checkpoint: next === undefined ? undefined : { checkpoint: next }
    }
  }
}
