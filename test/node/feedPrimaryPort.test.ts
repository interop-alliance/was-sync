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
 * A fake base port that serves `pages` of the changes feed, one page per
 * `query` call. When `endless` is set, every page is full and always carries a
 * non-null checkpoint, so a scan never reaches the feed's end (models a feed
 * larger than the page-scan budget). The write methods are unused here.
 */
function fakeBasePort(
  options: { pages?: WireDoc[][]; endless?: WireDoc[] } = {}
): WasSyncBasePort & { queryCalls: number } {
  const pages = options.pages ?? []
  const state = { queryCalls: 0 }
  return {
    get queryCalls() {
      return state.queryCalls
    },
    async query(): Promise<{
      documents: WireDoc[]
      checkpoint: SyncCheckpoint | null
    }> {
      const page = state.queryCalls
      state.queryCalls++
      if (options.endless !== undefined) {
        const last = options.endless[options.endless.length - 1]!
        return {
          documents: options.endless,
          checkpoint: { id: last.id, updatedAt: last.updatedAt }
        }
      }
      const documents = pages[page] ?? []
      const last = documents[documents.length - 1]
      // A final (or empty) page ends the feed with `checkpoint: null`.
      const isLast = page >= pages.length - 1 || documents.length === 0
      return {
        documents,
        checkpoint:
          isLast || last === undefined
            ? null
            : { id: last.id, updatedAt: last.updatedAt }
      }
    },
    async putContent() {
      return undefined
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

    expect(primary).toEqual({
      version: 7,
      updatedAt: '2026-01-01T00:00:00Z',
      deleted: false,
      data: { a: 1 },
      metaVersion: 2
    })
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
