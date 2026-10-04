/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Stamped fixture builders shared by the node suites: a valid `changes`-feed
 * document and a complete `/meta` stamp. Each carries the server-minted stamp
 * members a real feed or primary state would, so a test overrides only the
 * fields it is about.
 */
import type { ResourceMetaStamp, WireDoc } from '../../src/types.js'

/**
 * A valid stamped wire document: the content write stamp the server mints on
 * every resource record, plus the envelope the feed requires. The checkpoint
 * is derived from the id so a fake feed can resume at any document.
 *
 * @param over {Partial<WireDoc> & { id: string }}
 * @returns {WireDoc}
 */
export function wire(over: Partial<WireDoc> & { id: string }): WireDoc {
  return {
    _deleted: false,
    kind: 'resource',
    contentType: 'application/json',
    updatedAt: '2026-01-01T00:00:00Z',
    updatedAtCounter: 1,
    originId: 'origin-a',
    checkpoint: `cp-${over.id}`,
    ...over
  }
}

/**
 * A complete `/meta` stamp, as a resource carries it once metadata exists.
 *
 * @param [over] {Partial<ResourceMetaStamp>}
 * @returns {ResourceMetaStamp}
 */
export function metaStamp(
  over: Partial<ResourceMetaStamp> = {}
): ResourceMetaStamp {
  return {
    updatedAt: '2026-01-01T00:00:00Z',
    updatedAtCounter: 1,
    originId: 'origin-a',
    generation: 'gen-a',
    ...over
  }
}
