/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the changes-feed primary re-read (`withFeedPrimaryRead`), driven
 * by a fake base port whose `query` returns scripted feed pages -- no server, no
 * RxDB engine. Covers the found / genuinely-absent / exhausted-scan paths, and
 * the per-push-batch memo that keeps k conflicting rows to one feed walk.
 */
import { describe, it, expect } from 'vitest'
import { withFeedPrimaryRead } from '../../src/feedPrimaryPort.js'
import type {
  PrimaryReadCache,
  SyncCheckpoint,
  WasSyncBasePort,
  WireDoc
} from '../../src/types.js'

/**
 * A fresh per-push-batch primary-read memo.
 */
function emptyCache(): PrimaryReadCache {
  return { byId: new Map(), inFlight: null }
}

/**
 * A fake base port that serves `pages` of the changes feed, honoring the
 * checkpoint each `query` sends: no checkpoint serves the first page, and a
 * page's resume checkpoint (its last document's `checkpoint`) serves the page
 * after it. The final page ends the feed with `checkpoint: null`, or with
 * `tailCheckpoint` when one is given (an empty final page carrying a resume
 * position). A checkpoint the fake never issued rejects, so a walk that resumes
 * from the wrong position fails loudly. When `endless` is set, every query
 * answers the same full page with a non-null checkpoint, so a scan never
 * reaches the feed's end (models a feed larger than the page-scan budget).
 * Every query's arguments are recorded in `queries`. The write methods are
 * unused here.
 */
function fakeBasePort(
  options: {
    pages?: WireDoc[][]
    tailCheckpoint?: SyncCheckpoint
    endless?: WireDoc[]
  } = {}
): WasSyncBasePort & {
  queryCalls: number
  queries: Array<{ checkpoint?: SyncCheckpoint; limit: number }>
} {
  const pages = options.pages ?? []
  const queries: Array<{ checkpoint?: SyncCheckpoint; limit: number }> = []
  // The resume checkpoint each page reports, keyed to the page it resumes at.
  const pageAfter = new Map<SyncCheckpoint, number>()
  pages.slice(0, -1).forEach((documents, index) => {
    const last = documents[documents.length - 1]
    if (last !== undefined) {
      pageAfter.set(last.checkpoint, index + 1)
    }
  })
  return {
    get queryCalls() {
      return queries.length
    },
    queries,
    async query(args): Promise<{
      documents: WireDoc[]
      checkpoint: SyncCheckpoint | null
    }> {
      queries.push(args)
      if (options.endless !== undefined) {
        const last = options.endless[options.endless.length - 1]!
        return {
          documents: options.endless,
          checkpoint: last.checkpoint
        }
      }
      let pageIndex = 0
      if (args.checkpoint !== undefined) {
        const resumed = pageAfter.get(args.checkpoint)
        if (resumed === undefined) {
          throw new Error(`fake feed never issued "${args.checkpoint}"`)
        }
        pageIndex = resumed
      }
      const documents = pages[pageIndex] ?? []
      const last = documents[documents.length - 1]
      if (pageIndex >= pages.length - 1) {
        return { documents, checkpoint: options.tailCheckpoint ?? null }
      }
      // A non-final empty page ends the feed with `checkpoint: null` too.
      return { documents, checkpoint: last?.checkpoint ?? null }
    },
    async putContent() {
      return { version: 0 } // unused here; get() is what this suite exercises
    },
    async deleteContent() {
      return undefined
    },
    async putMeta() {
      return undefined
    }
  }
}

function wire(over: Partial<WireDoc> & { id: string }): WireDoc {
  return {
    _deleted: false,
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    checkpoint: `cp-${over.id}`,
    ...over
  }
}

describe('withFeedPrimaryRead get', () => {
  it('resolves the primary state from the feed body when the resource is found', async () => {
    const base = fakeBasePort({
      pages: [
        [
          wire({ id: 'other', version: 4 }),
          wire({ id: 'r1', version: 7, data: { a: 1 }, metaVersion: 2 })
        ]
      ]
    })
    const port = withFeedPrimaryRead(base)

    const primary = await port.get({ id: 'r1' })

    expect(primary).toStrictEqual({
      version: 7,
      updatedAt: '2026-01-01T00:00:00Z',
      deleted: false,
      data: { a: 1 },
      metaVersion: 2
    })
    // The feed doc declared no writer label, so the key is absent outright.
    expect('writerId' in primary!).toBe(false)
  })

  it('follows the checkpoint chain to a resource on a later page', async () => {
    const base = fakeBasePort({
      pages: [
        [wire({ id: 'a' }), wire({ id: 'b' })],
        [wire({ id: 'c' }), wire({ id: 'd' })],
        [wire({ id: 'r1', version: 7 }), wire({ id: 'e' })]
      ]
    })
    const port = withFeedPrimaryRead(base)

    expect(await port.get({ id: 'r1' })).toMatchObject({ version: 7 })
    // Each page resumes from the checkpoint the previous page reported; the
    // first page sends none at all.
    expect(base.queries).toStrictEqual([
      { limit: 500 },
      { checkpoint: 'cp-b', limit: 500 },
      { checkpoint: 'cp-d', limit: 500 }
    ])
  })

  it('walks every page before reporting a multi-page feed absence', async () => {
    const base = fakeBasePort({
      pages: [[wire({ id: 'a' })], [wire({ id: 'b' })], [wire({ id: 'c' })]]
    })
    const port = withFeedPrimaryRead(base)

    expect(await port.get({ id: 'missing' })).toBeNull()
    expect(base.queries.map(query => query.checkpoint)).toStrictEqual([
      undefined,
      'cp-a',
      'cp-b'
    ])
  })

  it('stops at an empty page even when it carries a resume checkpoint', async () => {
    // The feed's end shows as an empty page whose checkpoint is still
    // non-null. The walk must stop on the empty page alone; resuming from
    // `cp-tail` would ask the fake for a position it never issued.
    const base = fakeBasePort({
      pages: [[wire({ id: 'a' }), wire({ id: 'b' })], []],
      tailCheckpoint: 'cp-tail'
    })
    const port = withFeedPrimaryRead(base)

    expect(await port.get({ id: 'missing' })).toBeNull()
    expect(base.queries).toStrictEqual([
      { limit: 500 },
      { checkpoint: 'cp-b', limit: 500 }
    ])
  })

  it('carries the key epoch stamp into the primary state', async () => {
    const base = fakeBasePort({
      pages: [[wire({ id: 'r1', version: 7, data: { a: 1 }, epoch: 'e3' })]]
    })
    const port = withFeedPrimaryRead(base)

    expect(await port.get({ id: 'r1' })).toMatchObject({
      version: 7,
      epoch: 'e3'
    })
  })

  it('carries the writer label into the primary state', async () => {
    const base = fakeBasePort({
      pages: [
        [wire({ id: 'r1', version: 7, data: { a: 1 }, writerId: 'writer-b' })]
      ]
    })
    const port = withFeedPrimaryRead(base)

    expect(await port.get({ id: 'r1' })).toMatchObject({
      version: 7,
      writerId: 'writer-b'
    })
  })

  it('carries the opaque etag and metaEtag validators into the primary state', async () => {
    // The CORS-blocked deployment this seam exists for still needs a validator
    // to echo back as the retry's `ifMatch`; the feed body carries it just
    // like every other field this wrapper reads.
    const base = fakeBasePort({
      pages: [
        [
          wire({
            id: 'r1',
            version: 7,
            data: { a: 1 },
            metaVersion: 2,
            etag: '"etag-7"',
            metaEtag: '"etag-2"'
          })
        ]
      ]
    })
    const port = withFeedPrimaryRead(base)

    expect(await port.get({ id: 'r1' })).toMatchObject({
      version: 7,
      etag: '"etag-7"',
      metaVersion: 2,
      metaEtag: '"etag-2"'
    })
  })

  it('returns null when the scan reaches the feed end without the resource', async () => {
    // A completed scan (checkpoint: null) that never saw the id: genuinely
    // absent (a delete/delete race), so the conflict assembler tombstones it.
    const base = fakeBasePort({
      pages: [[wire({ id: 'a' }), wire({ id: 'b' })]]
    })
    const port = withFeedPrimaryRead(base)

    const primary = await port.get({ id: 'missing' })

    expect(primary).toBeNull()
  })

  it('returns null when the feed is empty', async () => {
    const base = fakeBasePort({ pages: [[]] })
    const port = withFeedPrimaryRead(base)

    expect(await port.get({ id: 'r1' })).toBeNull()
  })

  it('throws a retryable error when the page-scan budget is exhausted', async () => {
    // A feed that never ends and never contains the id: the scan runs out of
    // its page budget without reaching the end. Reporting null here would
    // fabricate a false tombstone, so `get` must throw so replication retries.
    const base = fakeBasePort({ endless: [wire({ id: 'other' })] })
    const port = withFeedPrimaryRead(base)

    await expect(port.get({ id: 'r1' })).rejects.toThrow(
      /exhausted its .* scan budget/
    )
    // It scanned the full budget (MAX_PAGES) before giving up.
    expect(base.queryCalls).toBe(50)
  })
})

describe('withFeedPrimaryRead get with a batch cache', () => {
  it('memoizes every document it pages past, so a sibling read costs no walk', async () => {
    const base = fakeBasePort({
      pages: [[wire({ id: 'r1', version: 7 }), wire({ id: 'r2', version: 9 })]]
    })
    const port = withFeedPrimaryRead(base)
    const cache = emptyCache()

    expect(await port.get({ id: 'r1', cache })).toMatchObject({ version: 7 })
    expect(base.queryCalls).toBe(1)
    // `r2` was paged past on the way to `r1`, so it is answered from the memo.
    expect(await port.get({ id: 'r2', cache })).toMatchObject({ version: 9 })
    expect(base.queryCalls).toBe(1)
  })

  it('memoizes the documents of every page a multi-page walk passes', async () => {
    const base = fakeBasePort({
      pages: [
        [wire({ id: 'r2', version: 9 })],
        [wire({ id: 'r3', version: 11 })],
        [wire({ id: 'r1', version: 7 })]
      ]
    })
    const port = withFeedPrimaryRead(base)
    const cache = emptyCache()

    expect(await port.get({ id: 'r1', cache })).toMatchObject({ version: 7 })
    expect(base.queryCalls).toBe(3)
    expect(await port.get({ id: 'r2', cache })).toMatchObject({ version: 9 })
    expect(await port.get({ id: 'r3', cache })).toMatchObject({ version: 11 })
    expect(base.queryCalls).toBe(3)
  })

  it('runs one walk, not one per row, for concurrent reads', async () => {
    const base = fakeBasePort({
      pages: [[wire({ id: 'r1', version: 7 }), wire({ id: 'r2', version: 9 })]]
    })
    const port = withFeedPrimaryRead(base)
    const cache = emptyCache()

    // Both reads start before either finishes -- the push batch's rows push
    // concurrently -- so the second must wait out the first walk, not start one.
    const [first, second] = await Promise.all([
      port.get({ id: 'r1', cache }),
      port.get({ id: 'r2', cache })
    ])

    expect(first).toMatchObject({ version: 7 })
    expect(second).toMatchObject({ version: 9 })
    expect(base.queryCalls).toBe(1)
  })

  it('memoizes an absent resource for the batch', async () => {
    const base = fakeBasePort({ pages: [[wire({ id: 'other' })]] })
    const port = withFeedPrimaryRead(base)
    const cache = emptyCache()

    expect(await port.get({ id: 'missing', cache })).toBeNull()
    expect(await port.get({ id: 'missing', cache })).toBeNull()
    expect(base.queryCalls).toBe(1)
  })

  it('walks again for an id the memo never saw', async () => {
    // A completed walk is NOT read as "every other id is absent": a row of the
    // same batch may have created its resource after the walk read the feed.
    const base = fakeBasePort({ pages: [[wire({ id: 'r1' })]] })
    const port = withFeedPrimaryRead(base)
    const cache = emptyCache()

    await port.get({ id: 'r1', cache })
    expect(base.queryCalls).toBe(1)
    await port.get({ id: 'r2', cache })
    expect(base.queryCalls).toBe(2)
  })

  it('leaves a failed walk to its own caller and lets a waiter retry', async () => {
    const base = fakeBasePort({ endless: [wire({ id: 'other' })] })
    const port = withFeedPrimaryRead(base)
    const cache = emptyCache()

    const [first, second] = await Promise.allSettled([
      port.get({ id: 'r1', cache }),
      port.get({ id: 'r2', cache })
    ])

    // The first read owns its error; the waiter does not inherit it, and runs
    // its own (equally doomed) walk rather than reporting a false tombstone.
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')
    expect(base.queryCalls).toBe(100)
  })
})
