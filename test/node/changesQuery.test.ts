/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the pull side of the sync adapter (the `changes`-feed mapping
 * and pull handler), driven by a fake WAS port -- no server, no RxDB engine.
 */
import { describe, it, expect, vi } from 'vitest'
import { createPullHandler, wireDocToRxDoc } from '../../src/changesQuery.js'
import type { SyncCheckpoint, WasSyncPort, WireDoc } from '../../src/types.js'

/**
 * A minimal fake port whose `query` replays a scripted list of pages. Only the
 * methods the pull path uses are implemented; the write methods throw.
 */
function fakePullPort(
  pages: Array<{ documents: WireDoc[]; checkpoint: SyncCheckpoint | null }>
): WasSyncPort & {
  calls: Array<{ checkpoint?: SyncCheckpoint; limit: number }>
} {
  const calls: Array<{ checkpoint?: SyncCheckpoint; limit: number }> = []
  let index = 0
  return {
    calls,
    async query(options) {
      calls.push(options)
      const page = pages[index] ?? { documents: [], checkpoint: null }
      index += 1
      return page
    },
    putContent: vi.fn(),
    deleteContent: vi.fn(),
    putMeta: vi.fn(),
    get: vi.fn()
  }
}

describe('wireDocToRxDoc', () => {
  it('maps a live content document, nesting the body under data', () => {
    const doc: WireDoc = {
      id: 'abc',
      _deleted: false,
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      data: { hello: 'world' }
    }
    expect(wireDocToRxDoc(doc)).toEqual({
      id: 'abc',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      data: { hello: 'world' },
      _deleted: false
    })
  })

  it('carries metaVersion and the custom envelope when present', () => {
    const doc: WireDoc = {
      id: 'abc',
      _deleted: false,
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      metaVersion: 2,
      data: { hello: 'world' },
      custom: { jwe: { ciphertext: '...' } }
    }
    expect(wireDocToRxDoc(doc)).toEqual({
      id: 'abc',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      metaVersion: 2,
      data: { hello: 'world' },
      custom: { jwe: { ciphertext: '...' } },
      _deleted: false
    })
  })

  it('carries the key epoch when the feed stamps one, and omits it otherwise', () => {
    const stamped = wireDocToRxDoc({
      id: 'abc',
      _deleted: false,
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      data: { hello: 'world' },
      epoch: 'e2'
    })
    expect(stamped.epoch).toBe('e2')
    const unstamped = wireDocToRxDoc({
      id: 'abc',
      _deleted: false,
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      data: { hello: 'world' }
    })
    expect('epoch' in unstamped).toBe(false)
  })

  it('carries the server-managed createdBy on a live document', () => {
    const doc: WireDoc = {
      id: 'abc',
      _deleted: false,
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      createdBy: 'did:key:z6MkCreator',
      data: { hello: 'world' }
    }
    expect(wireDocToRxDoc(doc)).toEqual({
      id: 'abc',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      createdBy: 'did:key:z6MkCreator',
      data: { hello: 'world' },
      _deleted: false
    })
  })

  it('carries the server-managed createdBy on a tombstone', () => {
    const doc: WireDoc = {
      id: 'gone',
      _deleted: true,
      updatedAt: '2026-01-02T00:00:00Z',
      version: 4,
      createdBy: 'did:key:z6MkCreator'
    }
    const rx = wireDocToRxDoc(doc)
    expect(rx).toEqual({
      id: 'gone',
      updatedAt: '2026-01-02T00:00:00Z',
      version: 4,
      createdBy: 'did:key:z6MkCreator',
      _deleted: true
    })
    // The attribution survives the delete even with no content body.
    expect('data' in rx).toBe(false)
  })

  it('carries the opaque etag and metaEtag validators when present', () => {
    const doc: WireDoc = {
      id: 'abc',
      _deleted: false,
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      metaVersion: 2,
      data: { hello: 'world' },
      custom: { jwe: { ciphertext: '...' } },
      etag: '"3mJr7AoUXx2.3"',
      metaEtag: '"9pQz1BbVYy4.2"'
    }
    expect(wireDocToRxDoc(doc)).toEqual({
      id: 'abc',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      metaVersion: 2,
      data: { hello: 'world' },
      custom: { jwe: { ciphertext: '...' } },
      etag: '"3mJr7AoUXx2.3"',
      metaEtag: '"9pQz1BbVYy4.2"',
      _deleted: false
    })
  })

  it('omits etag and metaEtag when the server recorded neither', () => {
    const doc: WireDoc = {
      id: 'abc',
      _deleted: false,
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      data: { hello: 'world' }
    }
    const rx = wireDocToRxDoc(doc)
    expect('etag' in rx).toBe(false)
    expect('metaEtag' in rx).toBe(false)
  })

  it('omits createdBy when the server recorded no creator', () => {
    const doc: WireDoc = {
      id: 'abc',
      _deleted: false,
      updatedAt: '2026-01-01T00:00:00Z',
      version: 3,
      data: { hello: 'world' }
    }
    expect('createdBy' in wireDocToRxDoc(doc)).toBe(false)
  })

  it('projects a tombstone with no data and no metadata', () => {
    const doc: WireDoc = {
      id: 'gone',
      _deleted: true,
      updatedAt: '2026-01-02T00:00:00Z',
      version: 4
    }
    const rx = wireDocToRxDoc(doc)
    expect(rx).toEqual({
      id: 'gone',
      updatedAt: '2026-01-02T00:00:00Z',
      version: 4,
      _deleted: true
    })
    expect('data' in rx).toBe(false)
    expect('custom' in rx).toBe(false)
  })
})

describe('createPullHandler', () => {
  const cpA: SyncCheckpoint = { id: 'a', updatedAt: '2026-01-01T00:00:01Z' }
  const cpB: SyncCheckpoint = { id: 'b', updatedAt: '2026-01-01T00:00:02Z' }

  it('omits the checkpoint on the first pull and forwards it on resume', async () => {
    const port = fakePullPort([
      {
        documents: [
          { id: 'a', _deleted: false, updatedAt: cpA.updatedAt, version: 1 }
        ],
        checkpoint: cpA
      }
    ])
    const pull = createPullHandler(port)

    const first = await pull(undefined, 100)
    expect(port.calls[0]).toEqual({ limit: 100 })
    expect('checkpoint' in port.calls[0]!).toBe(false)
    expect(first.checkpoint).toEqual(cpA)
    expect(first.documents).toHaveLength(1)

    await pull(cpA, 50)
    expect(port.calls[1]).toEqual({ checkpoint: cpA, limit: 50 })
  })

  it('iterates: each page returns its own checkpoint to resume from', async () => {
    const port = fakePullPort([
      {
        documents: [
          { id: 'a', _deleted: false, updatedAt: cpA.updatedAt, version: 1 }
        ],
        checkpoint: cpA
      },
      {
        documents: [
          { id: 'b', _deleted: false, updatedAt: cpB.updatedAt, version: 1 }
        ],
        checkpoint: cpB
      }
    ])
    const pull = createPullHandler(port)

    const page1 = await pull(undefined, 100)
    const page2 = await pull(page1.checkpoint, 100)

    expect(page1.checkpoint).toEqual(cpA)
    expect(page2.checkpoint).toEqual(cpB)
    expect(page2.documents[0]!.id).toBe('b')
  })

  it('keeps the prior checkpoint on an empty page (checkpoint: null)', async () => {
    const port = fakePullPort([{ documents: [], checkpoint: null }])
    const pull = createPullHandler(port)

    const result = await pull(cpA, 100)

    // The empty-page rule: do NOT persist null -- resume from the same position.
    expect(result.documents).toEqual([])
    expect(result.checkpoint).toEqual(cpA)
  })

  it('returns undefined checkpoint on a first, empty pull', async () => {
    const port = fakePullPort([{ documents: [], checkpoint: null }])
    const pull = createPullHandler(port)

    const result = await pull(undefined, 100)

    expect(result.documents).toEqual([])
    expect(result.checkpoint).toBeUndefined()
  })
})
