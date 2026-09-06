/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The `get` half of a {@link WasSyncPort}: resolves a resource's current primary
 * state (for the 412 conflict re-read) from the CHANGES-FEED BODY. Wraps a
 * {@link WasSyncBasePort} (query + conditional writes) and adds the `get` the
 * conflict assembler needs, producing a full {@link WasSyncPort}.
 *
 * Why the feed body rather than a `GET` ETag header: the mutable-head model
 * settles a 412 by re-reading the resource's current `version` and comparing
 * payloads (LWW). A raw `GET` reads that `version` from the response's `etag`
 * header -- which a browser hides on a CROSS-ORIGIN response unless the server
 * sends `Access-Control-Expose-Headers: etag`. A server that does not expose it
 * would make a cross-origin re-read report `version: 0`, so the loser of a push
 * race would re-push forever with a stale `If-Match` and never converge. The
 * `changes` feed carries `version` (and `data`, `_deleted`, ...) in the JSON
 * BODY, which CORS never strips, so resolving the primary from the feed is both
 * correct and origin-independent. Normal pull/push are unaffected (they already
 * read `version` from the feed body).
 *
 * Opt-in at construction: a deployment whose server exposes the ETag (the
 * reference server does) needs none of this and passes was-client's port
 * straight through. The walk's 50-page scan budget is a stated bound a padded
 * feed can exhaust, which is the other reason it is opted into rather than
 * applied by default; exhausting it throws so the cycle retries.
 */
import type {
  PrimaryReadCache,
  PrimaryState,
  SyncCheckpoint,
  WasSyncBasePort,
  WasSyncPort,
  WireDoc
} from './types.js'
import { copyOptionalBodyFields } from './types.js'

// A generous page cap so a pathological feed cannot spin forever; conflicts are
// rare and the dev/e2e feed is small, so a full scan is acceptable.
const MAX_PAGES = 50
const PAGE_SIZE = 500

/**
 * Builds a `PrimaryState` from a `changes`-feed document (all fields in-body).
 */
function toPrimaryState(doc: WireDoc): PrimaryState {
  const primary: PrimaryState = {
    version: doc.version,
    updatedAt: doc.updatedAt,
    deleted: doc._deleted
  }
  copyOptionalBodyFields({ source: doc, target: primary })
  return primary
}

/**
 * Walks the changes feed from its origin looking for one resource, memoizing
 * every document it pages past when the caller supplied a batch `cache`.
 *
 * @param options {object}
 * @param options.base {WasSyncBasePort}
 * @param options.id {string}
 * @param [options.cache] {PrimaryReadCache}
 * @returns {Promise<PrimaryState | null>}
 */
async function walkFeedFor({
  base,
  id,
  cache
}: {
  base: WasSyncBasePort
  id: string
  cache?: PrimaryReadCache
}): Promise<PrimaryState | null> {
  let checkpoint: SyncCheckpoint | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const { documents, checkpoint: next } = await base.query({
      ...(checkpoint !== undefined && { checkpoint }),
      limit: PAGE_SIZE
    })
    const byId = new Map(documents.map(doc => [doc.id, doc]))
    if (cache !== undefined) {
      for (const [docId, doc] of byId) {
        cache.byId.set(docId, toPrimaryState(doc))
      }
    }
    const found = byId.get(id)
    if (found) {
      return toPrimaryState(found)
    }
    // Reached the end of the feed without finding it: the resource is
    // genuinely absent (a delete/delete race), so report `null` and let the
    // conflict assembler synthesize a tombstone. Only THIS id is memoized as
    // absent, never "every id this completed walk did not see": a row of the
    // same batch may have created its resource after this walk read the feed,
    // and answering `null` for it would fabricate a tombstone and drop a live
    // payload -- exactly what the scan-budget throw below guards against.
    if (next === null || documents.length === 0) {
      cache?.byId.set(id, null)
      return null
    }
    checkpoint = next
  }
  // The page budget ran out before the feed's end. The feed is keyset-ordered
  // ascending on `updatedAt`, so a just-conflicted resource sits at the tail --
  // the least-reachable position -- and may well be past the cap. Reporting
  // `null` here would fabricate a false tombstone in the conflict assembler and
  // drop the winner's payload. Throw instead: RxDB treats a thrown push-handler
  // error as retryable, so the whole replication cycle retries rather than
  // diverging.
  throw new Error(
    `Feed primary re-read for resource "${id}" exhausted its ` +
      `${MAX_PAGES}-page scan budget without reaching the end of the ` +
      `changes feed; retrying.`
  )
}

/**
 * Wraps a base port with a `get` that resolves the primary state from the changes
 * feed. `query`, `putContent`, `deleteContent`, and `putMeta` pass straight
 * through.
 *
 * A walk starts at the feed's origin, so resolving one resource pages past many
 * others. With a per-push-batch `cache` the walk memoizes every one of them, and
 * a row that finds a walk already running waits for it rather than starting a
 * second -- so a batch of k conflicting rows costs one feed scan instead of k
 * concurrent ones. Without a `cache` the behavior is exactly as before.
 *
 * @param base {WasSyncBasePort}
 * @returns {WasSyncPort}
 */
export function withFeedPrimaryRead(base: WasSyncBasePort): WasSyncPort {
  return {
    query: base.query.bind(base),
    putContent: base.putContent.bind(base),
    deleteContent: base.deleteContent.bind(base),
    putMeta: base.putMeta.bind(base),
    async get({ id, cache }): Promise<PrimaryState | null> {
      if (cache === undefined) {
        return walkFeedFor({ base, id })
      }
      // Wait out whatever walk this batch already has running -- it pages past
      // every resource, so it may well answer this read -- then re-check the
      // memo. Looped because the walk we waited for can be followed by another.
      while (cache.inFlight !== null) {
        await cache.inFlight
      }
      const memoized = cache.byId.get(id)
      if (memoized !== undefined) {
        return memoized
      }
      // Publish this walk for the batch's other rows. Nothing above awaits
      // between the memo miss and here, so two rows can never both get past it.
      // The published promise SETTLES either way: a walk that threw is this
      // row's error to propagate, not a waiting row's.
      const walk = walkFeedFor({ base, id, cache })
      const clear = () => {
        cache.inFlight = null
      }
      cache.inFlight = walk.then(clear, clear)
      return walk
    }
  }
}
