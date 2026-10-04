/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the pull side of the sync adapter (the `changes`-feed mapping
 * and pull handler), driven by a fake WAS port -- no server, no RxDB engine.
 */
import { describe, it, expect, vi } from 'vitest'
import { WasSyncCheckpointError } from '@interop/was-client/sync'
import { createPullHandler, wireDocToRxDoc } from '../../src/changesQuery.js'
import { wire } from './fixtures.js'
import type {
  SyncCheckpoint,
  SyncedDoc,
  WasSyncPort,
  WireDoc,
  WithDeleted
} from '../../src/types.js'

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
    const doc = wire({ id: 'abc', data: { hello: 'world' } })
    expect(wireDocToRxDoc(doc)).toStrictEqual({
      id: 'abc',
      updatedAt: '2026-01-01T00:00:00Z',
      updatedAtCounter: 1,
      originId: 'origin-a',
      data: { hello: 'world' },
      _deleted: false
    })
  })

  it('maps the content stamp verbatim, a zero counter included, with no version', () => {
    const rx = wireDocToRxDoc(
      wire({ id: 'abc', updatedAtCounter: 0, originId: 'origin-z' })
    )
    expect(rx.updatedAtCounter).toBe(0)
    expect(rx.originId).toBe('origin-z')
    expect('version' in rx).toBe(false)
    expect('metaVersion' in rx).toBe(false)
  })

  it('carries the nested meta stamp and the custom envelope when present', () => {
    const meta = {
      updatedAt: '2026-01-01T00:00:05Z',
      updatedAtCounter: 0,
      originId: 'origin-b',
      generation: 'gen-1'
    }
    const doc = wire({
      id: 'abc',
      meta,
      data: { hello: 'world' },
      custom: { jwe: { ciphertext: '...' } }
    })
    expect(wireDocToRxDoc(doc)).toStrictEqual({
      id: 'abc',
      updatedAt: '2026-01-01T00:00:00Z',
      updatedAtCounter: 1,
      originId: 'origin-a',
      meta,
      data: { hello: 'world' },
      custom: { jwe: { ciphertext: '...' } },
      _deleted: false
    })
  })

  it('maps no meta for a document without one', () => {
    const rx = wireDocToRxDoc(wire({ id: 'abc', data: { hello: 'world' } }))
    expect('meta' in rx).toBe(false)
    expect('custom' in rx).toBe(false)
  })

  it('carries the key epoch when the feed stamps one, and omits it otherwise', () => {
    const stamped = wireDocToRxDoc(
      wire({ id: 'abc', data: { hello: 'world' }, epoch: 'e2' })
    )
    expect(stamped.epoch).toBe('e2')
    const unstamped = wireDocToRxDoc(
      wire({ id: 'abc', data: { hello: 'world' } })
    )
    expect('epoch' in unstamped).toBe(false)
  })

  it('carries the server-managed createdBy on a live document', () => {
    const doc = wire({
      id: 'abc',
      createdBy: 'did:key:z6MkCreator',
      data: { hello: 'world' }
    })
    expect(wireDocToRxDoc(doc)).toStrictEqual({
      id: 'abc',
      updatedAt: '2026-01-01T00:00:00Z',
      updatedAtCounter: 1,
      originId: 'origin-a',
      createdBy: 'did:key:z6MkCreator',
      data: { hello: 'world' },
      _deleted: false
    })
  })

  it('carries the server-managed createdBy on a tombstone', () => {
    const doc = wire({
      id: 'gone',
      _deleted: true,
      updatedAt: '2026-01-02T00:00:00Z',
      updatedAtCounter: 2,
      createdBy: 'did:key:z6MkCreator'
    })
    const rx = wireDocToRxDoc(doc)
    expect(rx).toStrictEqual({
      id: 'gone',
      updatedAt: '2026-01-02T00:00:00Z',
      updatedAtCounter: 2,
      originId: 'origin-a',
      createdBy: 'did:key:z6MkCreator',
      _deleted: true
    })
    // The attribution survives the delete even with no content body.
    expect('data' in rx).toBe(false)
  })

  it('carries the opaque etag and metaEtag validators when present', () => {
    const doc = wire({
      id: 'abc',
      data: { hello: 'world' },
      custom: { jwe: { ciphertext: '...' } },
      etag: '"3mJr7AoUXx2.3"',
      metaEtag: '"9pQz1BbVYy4.2"'
    })
    expect(wireDocToRxDoc(doc)).toStrictEqual({
      id: 'abc',
      updatedAt: '2026-01-01T00:00:00Z',
      updatedAtCounter: 1,
      originId: 'origin-a',
      data: { hello: 'world' },
      custom: { jwe: { ciphertext: '...' } },
      etag: '"3mJr7AoUXx2.3"',
      metaEtag: '"9pQz1BbVYy4.2"',
      _deleted: false
    })
  })

  it('omits etag and metaEtag when the server recorded neither', () => {
    const rx = wireDocToRxDoc(wire({ id: 'abc', data: { hello: 'world' } }))
    expect('etag' in rx).toBe(false)
    expect('metaEtag' in rx).toBe(false)
  })

  it('omits createdBy when the server recorded no creator', () => {
    const doc = wire({ id: 'abc', data: { hello: 'world' } })
    expect('createdBy' in wireDocToRxDoc(doc)).toBe(false)
  })

  it('projects a tombstone with no data and no metadata', () => {
    const doc = wire({
      id: 'gone',
      _deleted: true,
      updatedAt: '2026-01-02T00:00:00Z',
      updatedAtCounter: 2
    })
    const rx = wireDocToRxDoc(doc)
    expect(rx).toStrictEqual({
      id: 'gone',
      updatedAt: '2026-01-02T00:00:00Z',
      updatedAtCounter: 2,
      originId: 'origin-a',
      _deleted: true
    })
    expect('data' in rx).toBe(false)
    expect('custom' in rx).toBe(false)
    expect('meta' in rx).toBe(false)
  })

  it('does not carry the writerId into the local row, live or tombstone', () => {
    const live = wire({ id: 'abc', etag: '"e2"', data: { hello: 'world' } })
    const tombstone = wire({
      id: 'gone',
      _deleted: true,
      updatedAt: '2026-01-02T00:00:00Z',
      updatedAtCounter: 2
    })
    const cases: Array<[WireDoc, WithDeleted<SyncedDoc>]> = [
      [
        live,
        {
          id: 'abc',
          _deleted: false,
          updatedAt: '2026-01-01T00:00:00Z',
          updatedAtCounter: 1,
          originId: 'origin-a',
          etag: '"e2"',
          data: { hello: 'world' }
        }
      ],
      [
        tombstone,
        {
          id: 'gone',
          _deleted: true,
          updatedAt: '2026-01-02T00:00:00Z',
          updatedAtCounter: 2,
          originId: 'origin-a'
        }
      ]
    ]
    for (const [doc, expected] of cases) {
      const stamped = wireDocToRxDoc({ ...doc, writerId: 'writer-a' })
      expect(stamped).toStrictEqual(expected)
      expect('writerId' in stamped).toBe(false)
    }
  })
})

describe('createPullHandler', () => {
  const cpA: SyncCheckpoint = 'opaque-checkpoint-a'
  const cpB: SyncCheckpoint = 'opaque-checkpoint-b'
  const updatedAt = '2026-01-01T00:00:01Z'
  const doc = (id: string, checkpoint: SyncCheckpoint): WireDoc =>
    wire({ id, updatedAt, checkpoint })
  const rejected = new WasSyncCheckpointError()

  /**
   * A port that refuses every pull carrying a checkpoint and serves the one
   * page `documents` from the start of the feed.
   */
  function refusingPort(documents: WireDoc[]): WasSyncPort & {
    calls: Array<{ checkpoint?: SyncCheckpoint; limit: number }>
  } {
    const calls: Array<{ checkpoint?: SyncCheckpoint; limit: number }> = []
    return {
      calls,
      async query(options) {
        calls.push(options)
        if (options.checkpoint !== undefined) {
          throw rejected
        }
        return {
          documents,
          checkpoint: documents.at(-1)?.checkpoint ?? null
        }
      },
      putContent: vi.fn(),
      deleteContent: vi.fn(),
      putMeta: vi.fn(),
      get: vi.fn()
    }
  }

  it('omits the checkpoint on the first pull and forwards the unwrapped string on resume', async () => {
    const port = fakePullPort([
      {
        documents: [doc('a', cpA)],
        checkpoint: cpA
      }
    ])
    const pull = createPullHandler(port)

    const first = await pull(undefined, 100)
    expect(port.calls[0]).toEqual({ limit: 100 })
    expect('checkpoint' in port.calls[0]!).toBe(false)
    // Wrapped for RxDB: a bare string would be scattered by its checkpoint
    // stacking (`Object.assign`).
    expect(first.checkpoint).toEqual({ checkpoint: cpA })
    expect(first.documents).toHaveLength(1)

    await pull(first.checkpoint, 50)
    expect(port.calls[1]).toEqual({ checkpoint: cpA, limit: 50 })
  })

  it('iterates: each page returns its own checkpoint to resume from', async () => {
    const port = fakePullPort([
      {
        documents: [doc('a', cpA)],
        checkpoint: cpA
      },
      {
        documents: [doc('b', cpB)],
        checkpoint: cpB
      }
    ])
    const pull = createPullHandler(port)

    const page1 = await pull(undefined, 100)
    const page2 = await pull(page1.checkpoint, 100)

    expect(page1.checkpoint).toEqual({ checkpoint: cpA })
    expect(page2.checkpoint).toEqual({ checkpoint: cpB })
    expect(page2.documents[0]!.id).toBe('b')
  })

  it('keeps the prior checkpoint on an empty page (checkpoint: null)', async () => {
    const port = fakePullPort([{ documents: [], checkpoint: null }])
    const pull = createPullHandler(port)

    const result = await pull({ checkpoint: cpA }, 100)

    // The empty-page rule: do NOT persist null -- resume from the same position.
    expect(result.documents).toEqual([])
    expect(result.checkpoint).toEqual({ checkpoint: cpA })
  })

  it('restarts from the beginning when the server rejects the checkpoint', async () => {
    const port = refusingPort([doc('a', cpA)])
    const pull = createPullHandler(port)

    const result = await pull({ checkpoint: 'issued-elsewhere' }, 100)

    expect(port.calls).toEqual([
      { checkpoint: 'issued-elsewhere', limit: 100 },
      { limit: 100 }
    ])
    expect(result.checkpoint).toEqual({ checkpoint: cpA })
    expect(result.documents.map(doc => doc.id)).toEqual(['a'])
  })

  it('remembers a refused checkpoint and skips the 400 when RxDB offers it again', async () => {
    // An empty restarted feed gives RxDB nothing to persist, so it keeps
    // offering the refused checkpoint on every poll.
    const port = refusingPort([])
    const pull = createPullHandler(port)

    const first = await pull({ checkpoint: 'issued-elsewhere' }, 100)
    expect(first.checkpoint).toBeUndefined()
    expect(port.calls).toEqual([
      { checkpoint: 'issued-elsewhere', limit: 100 },
      { limit: 100 }
    ])

    await pull({ checkpoint: 'issued-elsewhere' }, 100)
    expect(port.calls).toHaveLength(3)
    expect(port.calls[2]).toEqual({ limit: 100 })
  })

  it('matches the refusal by name, as from another copy of was-client', async () => {
    const foreign = Object.assign(new Error('refused elsewhere'), {
      name: 'WasSyncCheckpointError'
    })
    const port = {
      calls: [] as Array<{ checkpoint?: SyncCheckpoint; limit: number }>,
      async query(options: { checkpoint?: SyncCheckpoint; limit: number }) {
        port.calls.push(options)
        if (options.checkpoint !== undefined) {
          throw foreign
        }
        return { documents: [], checkpoint: null }
      }
    }
    const pull = createPullHandler(port as unknown as WasSyncPort)

    await pull({ checkpoint: cpA }, 100)
    expect(port.calls).toEqual([
      { checkpoint: cpA, limit: 100 },
      { limit: 100 }
    ])
  })

  it('rethrows any other pull failure', async () => {
    const port = {
      async query() {
        throw Object.assign(new Error('nope'), { status: 400 })
      }
    } as unknown as WasSyncPort
    const pull = createPullHandler(port)

    await expect(pull({ checkpoint: cpA }, 100)).rejects.toThrow('nope')
  })

  it('returns undefined checkpoint on a first, empty pull', async () => {
    const port = fakePullPort([{ documents: [], checkpoint: null }])
    const pull = createPullHandler(port)

    const result = await pull(undefined, 100)

    expect(result.documents).toEqual([])
    expect(result.checkpoint).toBeUndefined()
  })
})
