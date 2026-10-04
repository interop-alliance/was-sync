/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the push side of the sync adapter (conditional-write routing
 * and the 412 conflict assembler), driven by a fake WAS port -- no server, no
 * RxDB engine.
 */
import { describe, it, expect } from 'vitest'
import { captureLogger } from '@interop/logger'

import {
  WasSyncAuthError,
  WasSyncConflictError,
  WasSyncNotFoundError
} from '@interop/was-client/sync'
import { createPushHandler, type PushWriteAck } from '../../src/pushWrites.js'
import { withFeedPrimaryRead } from '../../src/feedPrimaryPort.js'
import { setLogger } from '../../src/log.js'
import { metaStamp, wire } from './fixtures.js'
import type {
  PrimaryReadCache,
  PrimaryState,
  SyncedDoc,
  WasSyncBasePort,
  WasSyncPort,
  WireDoc,
  WithDeleted,
  WriteAck
} from '../../src/types.js'

/**
 * A deterministic, opaque-looking content etag for the n-th accepted write.
 * The real server's `ETag` is opaque and no stamp member rebuilds it, so every
 * fixture that wants a conditional write to fire must set this explicitly on
 * the fixture rather than have it derived.
 *
 * @param count {number}
 * @returns {string}
 */
function etagFor(count: number): string {
  return `"etag-${count}"`
}

/**
 * The `/meta` counterpart of {@link etagFor}, distinct from it so an ack
 * assertion tells which write earned which validator.
 *
 * @param count {number}
 * @returns {string}
 */
function metaEtagFor(count: number): string {
  return `"meta-etag-${count}"`
}

/**
 * The server-minted halves of a content write stamp, as a stamped server state
 * carries them beside `updatedAt`.
 */
const contentStamp = { updatedAtCounter: 3, originId: 'origin-a' }

type WriteCall =
  | {
      kind: 'putContent'
      id: string
      data: unknown
      ifMatch?: string
      ifNoneMatch?: boolean
      epoch?: string
      writerId?: string
    }
  | { kind: 'deleteContent'; id: string; ifMatch?: string; writerId?: string }
  | {
      kind: 'putMeta'
      id: string
      custom?: unknown
      ifMatch?: string
      ifNoneMatch?: boolean
      writerId?: string
    }

/**
 * A fake port that records every write VERBATIM (each recorded call spreads the
 * options object it received, so an absent member -- a cleared `custom`, an
 * absent `epoch` -- is genuinely absent from the record and testable with
 * `in`), optionally throws a conflict, a not-found signal, a masked-404 auth
 * error, or the guarded-write refusal for a chosen (kind,id), serves a scripted
 * `get` primary state (or a scripted `get` rejection) for the re-read while
 * recording the options each `get` received, and acks writes like a server
 * that exposes its validators: each accepted content write returns the next
 * content etag (via {@link etagFor}), each accepted meta write the next meta
 * etag (via {@link metaEtagFor}), counted per id from 1. `ackWrites: false`
 * models a server whose write responses carry no `ETag` the client can read
 * (e.g. cross-origin without `Access-Control-Expose-Headers`): every write is
 * accepted with an empty ack.
 */
function fakePushPort(
  options: {
    conflictOn?: { kind: WriteCall['kind']; id: string }
    notFoundOn?: { kind: WriteCall['kind']; id: string }
    auth404On?: { kind: WriteCall['kind']; id: string }
    primary?: PrimaryState | null
    getRejectsWith?: unknown
    ackWrites?: boolean
  } = {}
): WasSyncPort & {
  writes: WriteCall[]
  getCalls: string[]
  getOptions: Array<{ id: string; cache?: PrimaryReadCache }>
} {
  const ackWrites = options.ackWrites ?? true
  const writes: WriteCall[] = []
  const getCalls: string[] = []
  const getOptions: Array<{ id: string; cache?: PrimaryReadCache }> = []
  const contentWrites = new Map<string, number>()
  const metaWrites = new Map<string, number>()
  const maybeReject = (kind: WriteCall['kind'], id: string) => {
    if (options.conflictOn?.kind === kind && options.conflictOn.id === id) {
      throw new WasSyncConflictError()
    }
    if (options.notFoundOn?.kind === kind && options.notFoundOn.id === id) {
      throw new WasSyncNotFoundError()
    }
    if (options.auth404On?.kind === kind && options.auth404On.id === id) {
      throw new WasSyncAuthError(404)
    }
  }
  // Counts this id's accepted writes and acks the validator the count names;
  // `ackWrites: false` acks nothing, modeling a backend that exposes no `ETag`.
  const ackNext = (
    counts: Map<string, number>,
    id: string,
    validatorFor: (count: number) => string
  ): WriteAck => {
    const next = (counts.get(id) ?? 0) + 1
    counts.set(id, next)
    return ackWrites ? { etag: validatorFor(next) } : {}
  }
  return {
    writes,
    getCalls,
    getOptions,
    async query() {
      return { documents: [], checkpoint: null }
    },
    async putContent(putOptions) {
      writes.push({ kind: 'putContent', ...putOptions })
      maybeReject('putContent', putOptions.id)
      return ackNext(contentWrites, putOptions.id, etagFor)
    },
    async deleteContent(deleteOptions) {
      writes.push({ kind: 'deleteContent', ...deleteOptions })
      maybeReject('deleteContent', deleteOptions.id)
      // Like the reference server: a DELETE 204 carries no ETag.
      return undefined
    },
    async putMeta(metaOptions) {
      writes.push({ kind: 'putMeta', ...metaOptions })
      maybeReject('putMeta', metaOptions.id)
      return ackNext(metaWrites, metaOptions.id, metaEtagFor)
    },
    async get(getOptionsReceived) {
      getCalls.push(getOptionsReceived.id)
      getOptions.push({ ...getOptionsReceived })
      if (options.getRejectsWith !== undefined) {
        throw options.getRejectsWith
      }
      return options.primary ?? null
    }
  }
}

function newDoc(over: Partial<WithDeleted<SyncedDoc>>): WithDeleted<SyncedDoc> {
  return {
    id: 'r1',
    updatedAt: '2026-01-01T00:00:00Z',
    _deleted: false,
    ...over
  }
}

describe('createPushHandler routing', () => {
  it('creates content with If-None-Match when there is no assumed primary', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'putContent', id: 'r1', data: { a: 1 }, ifNoneMatch: true }
    ])
  })

  it('creates content then metadata (content first) on a create with custom', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      {
        newDocumentState: newDoc({
          id: 'r1',
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(port.writes.map(w => w.kind)).toEqual(['putContent', 'putMeta'])
    expect(port.writes[1]).toEqual({
      kind: 'putMeta',
      id: 'r1',
      custom: { jwe: 'x' },
      ifNoneMatch: true
    })
  })

  it('updates content with If-Match echoing the assumed etag when the body changed', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(5),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({ ...contentStamp, data: { a: 2 } })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'putContent', id: 'r1', data: { a: 2 }, ifMatch: etagFor(5) }
    ])
  })

  it('routes a metadata-only change to /meta with If-Match echoing the assumed metaEtag, no content write', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          metaEtag: metaEtagFor(2),
          data: { a: 1 },
          custom: { jwe: 'old' }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          data: { a: 1 },
          custom: { jwe: 'new' }
        })
      }
    ])

    expect(port.writes).toEqual([
      {
        kind: 'putMeta',
        id: 'r1',
        custom: { jwe: 'new' },
        ifMatch: metaEtagFor(2)
      }
    ])
  })

  it('creates metadata with If-None-Match when the primary has no /meta record yet', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(5),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'putMeta', id: 'r1', custom: { jwe: 'x' }, ifNoneMatch: true }
    ])
  })

  it('treats a key-order-only difference as unchanged (no write)', async () => {
    // `bodiesEqual` is JCS-canonical, so a re-serialized body draws no spurious
    // `PUT` on either half.
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          data: { a: 1, b: 2 },
          custom: { jwe: 'x', tag: 'y' }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          data: { b: 2, a: 1 },
          custom: { tag: 'y', jwe: 'x' }
        })
      }
    ])

    expect(port.writes).toEqual([])
  })

  it('deletes with If-Match echoing the assumed etag and skips any metadata write', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(7),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          _deleted: true,
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: etagFor(7) }
    ])
  })

  it('writes the cleared metadata state when custom is removed', async () => {
    // A metadata CLEAR: the new state carries no `custom` while the assumed
    // primary does. It must reach /meta as a write with NO `custom` member (the
    // server's replace clears what the body omits), not be skipped -- otherwise
    // the removal never replicates.
    const port = fakePushPort()
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          metaEtag: metaEtagFor(2),
          data: { a: 1 },
          custom: { jwe: 'old' }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          data: { a: 1 }
        })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'putMeta', id: 'r1', ifMatch: metaEtagFor(2) }
    ])
    expect('custom' in port.writes[0]!).toBe(false)
  })

  it('sends the row epoch on the content write, and nothing when it has none', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 }, epoch: 'e2' }) },
      { newDocumentState: newDoc({ id: 'r2', data: { a: 1 } }) }
    ])

    const stamped = port.writes.find(write => write.id === 'r1')!
    const unstamped = port.writes.find(write => write.id === 'r2')!
    expect(stamped).toEqual({
      kind: 'putContent',
      id: 'r1',
      data: { a: 1 },
      epoch: 'e2',
      ifNoneMatch: true
    })
    expect('epoch' in unstamped).toBe(false)
  })

  it('sends the row epoch on an update write too', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(5),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          data: { a: 2 },
          epoch: 'e2'
        })
      }
    ])

    expect(port.writes).toEqual([
      {
        kind: 'putContent',
        id: 'r1',
        data: { a: 2 },
        epoch: 'e2',
        ifMatch: etagFor(5)
      }
    ])
  })
})

describe('createPushHandler /meta create-or-update routing', () => {
  // The `/meta` record exists on a live assumed primary when it carries `meta`
  // (its stamp, off the feed) or `metaEtag` (its validator, off a `204` ack
  // that brought no stamp). Either makes the write an update, conditional only
  // when the validator is held; neither makes it a create. A tombstone holds
  // no live record to condition on, so it is a create whatever it carries.
  it.each([
    {
      state: 'neither meta nor metaEtag',
      assumed: { _deleted: false },
      expected: { ifNoneMatch: true }
    },
    {
      state: 'metaEtag only (after a /meta ack, before its echo)',
      assumed: { _deleted: false, metaEtag: metaEtagFor(2) },
      expected: { ifMatch: metaEtagFor(2) }
    },
    {
      state: 'meta only (a hidden-ETag deployment)',
      assumed: { _deleted: false, meta: metaStamp() },
      expected: {}
    },
    {
      state: 'both meta and metaEtag',
      assumed: {
        _deleted: false,
        meta: metaStamp(),
        metaEtag: metaEtagFor(2)
      },
      expected: { ifMatch: metaEtagFor(2) }
    },
    {
      state: 'a tombstone carrying both',
      assumed: { _deleted: true, meta: metaStamp(), metaEtag: metaEtagFor(2) },
      expected: { ifNoneMatch: true }
    }
  ])(
    'sends the /meta write for an assumed primary with $state',
    async ({ assumed, expected }) => {
      const port = fakePushPort()
      const push = createPushHandler({ port })

      const conflicts = await push([
        {
          assumedMasterState: newDoc({
            ...contentStamp,
            etag: etagFor(5),
            data: { a: 1 },
            custom: { jwe: 'old' },
            ...assumed
          }),
          newDocumentState: newDoc({
            ...contentStamp,
            data: { a: 1 },
            custom: { jwe: 'new' }
          })
        }
      ])

      expect(conflicts).toEqual([])
      // Strict: an `ifMatch` or `ifNoneMatch` member set to `undefined` would
      // still be sent as a precondition by a port that tests with `in`.
      expect(port.writes.find(write => write.kind === 'putMeta')).toStrictEqual(
        {
          kind: 'putMeta',
          id: 'r1',
          custom: { jwe: 'new' },
          ...expected
        }
      )
    }
  )
})

describe('createPushHandler conflicts', () => {
  it('re-reads and returns the primary state on a 412', async () => {
    const primary: PrimaryState = {
      updatedAt: '2026-02-02T00:00:00Z',
      ...contentStamp,
      deleted: false,
      data: { a: 99 }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(port.getCalls).toEqual(['r1'])
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        data: { a: 99 },
        _deleted: false
      }
    ])
  })

  it('synthesizes a tombstone conflict carrying only id, updatedAt, and _deleted when the resource is now absent', async () => {
    // The plain port's null re-read says only that no live resource is there,
    // so the entry describes a state the driver could not read: no stamp
    // member beyond `updatedAt`, no etag, no meta. Nothing of the assumed
    // primary's stands in for the server's state, though it carries all of
    // them here. Its `updatedAt` is the new local state's, not the assumed
    // primary's. A null re-read is not drift, so the refused delete is not
    // re-issued.
    const port = fakePushPort({
      conflictOn: { kind: 'deleteContent', id: 'r1' },
      primary: null
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          updatedAt: '2025-12-31T00:00:00Z',
          ...contentStamp,
          etag: etagFor(4),
          meta: metaStamp(),
          metaEtag: metaEtagFor(1),
          data: { a: 1 },
          custom: { jwe: 'x' }
        }),
        newDocumentState: newDoc({
          updatedAt: '2026-01-01T00:00:00Z',
          ...contentStamp,
          meta: metaStamp(),
          _deleted: true
        })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: etagFor(4) }
    ])
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00Z',
        _deleted: true
      }
    ])
  })

  it("carries the primary's stamp, meta, and custom verbatim into the assembled conflict, with no version", async () => {
    const primary: PrimaryState = {
      updatedAt: '2026-03-03T00:00:00Z',
      updatedAtCounter: 0,
      originId: 'origin-b',
      meta: metaStamp({
        updatedAt: '2026-03-03T00:00:00Z',
        updatedAtCounter: 7,
        originId: 'origin-b',
        generation: 'gen-b'
      }),
      metaEtag: metaEtagFor(6),
      etag: etagFor(3),
      deleted: false,
      data: { a: 1 },
      custom: { jwe: 'srv' }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'putMeta', id: 'r1' },
      primary
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          metaEtag: metaEtagFor(5),
          data: { a: 1 },
          custom: { jwe: 'old' }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          data: { a: 1 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    // `updatedAtCounter: 0` is a valid stamp (the first write in a
    // millisecond) and is carried, not dropped as falsy.
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-03-03T00:00:00Z',
        updatedAtCounter: 0,
        originId: 'origin-b',
        meta: metaStamp({
          updatedAt: '2026-03-03T00:00:00Z',
          updatedAtCounter: 7,
          originId: 'origin-b',
          generation: 'gen-b'
        }),
        metaEtag: metaEtagFor(6),
        etag: etagFor(3),
        data: { a: 1 },
        custom: { jwe: 'srv' },
        _deleted: false
      }
    ])
  })

  it('carries the server-managed createdBy into the assembled conflict', async () => {
    const primary: PrimaryState = {
      updatedAt: '2026-02-02T00:00:00Z',
      ...contentStamp,
      createdBy: 'did:key:z6MkCreator',
      data: { a: 99 }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(conflicts[0]).toMatchObject({
      id: 'r1',
      createdBy: 'did:key:z6MkCreator',
      _deleted: false
    })
  })

  it('carries the primary key epoch into the assembled conflict', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary: {
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        deleted: false,
        data: { a: 99 },
        epoch: 'e3'
      }
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 }, epoch: 'e2' }) }
    ])

    expect(conflicts[0]).toMatchObject({ id: 'r1', epoch: 'e3' })
  })

  it('propagates a non-conflict error so RxDB retries the batch', async () => {
    const port: WasSyncPort = {
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        throw new Error('network down')
      },
      async deleteContent() {},
      async putMeta() {},
      async get() {
        return null
      }
    }
    const push = createPushHandler({ port })

    await expect(
      push([{ newDocumentState: newDoc({ data: { a: 1 } }) }])
    ).rejects.toThrow('network down')
  })

  it('processes multiple rows and returns only the conflicting ones', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'bad' },
      primary: {
        updatedAt: '2026-01-05T00:00:00Z',
        ...contentStamp,
        deleted: false,
        data: { server: true }
      }
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'ok', data: { a: 1 } }) },
      { newDocumentState: newDoc({ id: 'bad', data: { a: 2 } }) }
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.id).toBe('bad')
  })

  it('logs the refused write with the assumed and re-read validators', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary: {
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        etag: etagFor(9),
        data: { a: 99 }
      }
    })
    const push = createPushHandler({ port })
    const capture = captureLogger('sync')
    const previous = setLogger(capture.logger)

    try {
      await push([
        {
          assumedMasterState: newDoc({
            ...contentStamp,
            etag: etagFor(4),
            data: { a: 1 }
          }),
          newDocumentState: newDoc({ ...contentStamp, data: { a: 2 } })
        }
      ])

      expect(capture.events).toHaveLength(1)
      expect(capture.events[0]).toMatchObject({
        level: 'debug',
        msg: 'Write refused; handing the conflict entry to RxDB',
        data: {
          id: 'r1',
          assumedEtag: etagFor(4),
          etag: etagFor(9),
          deleted: false
        }
      })
      expect(capture.events[0]!.data).not.toHaveProperty('assumedVersion')
      expect(capture.events[0]!.data).not.toHaveProperty('version')
    } finally {
      setLogger(previous)
    }
  })
})

describe('createPushHandler write acks', () => {
  it('reports the acked content etag on a create', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(conflicts).toEqual([])
    expect(acks).toStrictEqual([{ id: 'r1', etag: etagFor(1) }])
  })

  it('echoes the acked etag verbatim as If-Match on the next update push', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    // Create: the server acks its etag; the caller writes it back into the
    // row, so the next push's assumed primary carries that etag.
    await push([{ newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }])
    expect(acks).toStrictEqual([{ id: 'r1', etag: etagFor(1) }])
    const [createAck] = acks
    const writtenBack = newDoc({
      id: 'r1',
      etag: createAck!.etag!,
      data: { a: 1 }
    })

    // Update: the assumed primary is the row the ack was written back into.
    const conflicts = await push([
      {
        assumedMasterState: writtenBack,
        newDocumentState: { ...writtenBack, data: { a: 2 } }
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes[1]).toEqual({
      kind: 'putContent',
      id: 'r1',
      data: { a: 2 },
      ifMatch: etagFor(1)
    })
    expect(acks[1]).toStrictEqual({ id: 'r1', etag: etagFor(2) })
  })

  it('reports the acked metaEtag on a metadata write', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(1),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(acks).toStrictEqual([{ id: 'r1', metaEtag: metaEtagFor(1) }])
  })

  it('does not report an ack for a delete whose response carries no ETag', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ etag: etagFor(1), data: { a: 1 } }),
        newDocumentState: newDoc({ _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(acks).toEqual([])
  })

  it.each([
    {
      acked: 'both validators',
      contentAck: { etag: etagFor(1) },
      metaAck: { etag: metaEtagFor(1) },
      expected: [{ id: 'r1', etag: etagFor(1), metaEtag: metaEtagFor(1) }]
    },
    {
      acked: 'the content etag alone',
      contentAck: { etag: etagFor(1) },
      metaAck: {},
      expected: [{ id: 'r1', etag: etagFor(1) }]
    },
    {
      acked: 'the metaEtag alone',
      contentAck: {},
      metaAck: { etag: metaEtagFor(1) },
      expected: [{ id: 'r1', metaEtag: metaEtagFor(1) }]
    },
    {
      acked: 'no validator (no ETag on either response)',
      contentAck: {},
      metaAck: {},
      expected: []
    }
  ])(
    'reports an ack carrying $acked',
    async ({ contentAck, metaAck, expected }) => {
      // An opaque validator alone is acked state, and a write accepted with no
      // `ETag` in its response acks nothing: with neither validator there is
      // no ack and no `onWriteAccepted` call, though both writes landed.
      const port = fakePushPort()
      port.putContent = async putOptions => {
        port.writes.push({ kind: 'putContent', ...putOptions })
        return contentAck
      }
      port.putMeta = async metaOptions => {
        port.writes.push({ kind: 'putMeta', ...metaOptions })
        return metaAck
      }
      const acks: PushWriteAck[] = []
      const push = createPushHandler({
        port,
        onWriteAccepted: async ack => {
          acks.push(ack)
        }
      })

      const conflicts = await push([
        {
          newDocumentState: newDoc({
            id: 'r1',
            data: { a: 1 },
            custom: { tag: 'x' }
          })
        }
      ])

      expect(conflicts).toEqual([])
      expect(port.writes.map(write => write.kind)).toEqual([
        'putContent',
        'putMeta'
      ])
      // Strict: an `etag: undefined` member would read as "acked" downstream.
      expect(acks).toStrictEqual(expected)
    }
  )

  it('reports no ack when the server exposes no write ETags, and sends no If-Match on the next update', async () => {
    // A backend with no readable `ETag` on write responses accepts the write
    // and hands back no validator, so there is no acked state to write back
    // and the row keeps the validator it had (none, for a fresh create).
    const port = fakePushPort({ ackWrites: false })
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    await push([{ newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }])
    expect(acks).toEqual([])

    const unacked = newDoc({ id: 'r1', ...contentStamp, data: { a: 1 } })
    await push([
      {
        assumedMasterState: unacked,
        newDocumentState: { ...unacked, data: { a: 2 } }
      }
    ])

    expect(port.writes[1]).toStrictEqual({
      kind: 'putContent',
      id: 'r1',
      data: { a: 2 }
    })
    expect(acks).toEqual([])
  })

  it('reports the acked etag of a delete whose response carries one', async () => {
    const port = fakePushPort()
    port.deleteContent = async deleteOptions => {
      port.writes.push({ kind: 'deleteContent', ...deleteOptions })
      return { etag: etagFor(8) }
    }
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(7),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({ ...contentStamp, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: etagFor(7) }
    ])
    expect(acks).toStrictEqual([{ id: 'r1', etag: etagFor(8) }])
  })

  it('keeps only the content ack when the metadata write resolves no ack', async () => {
    // A `/meta` write accepted with no validator in its response (the port
    // resolves `undefined`) contributes nothing to the ack, and does not
    // discard the content half's.
    const port = fakePushPort()
    port.putMeta = async metaOptions => {
      port.writes.push({ kind: 'putMeta', ...metaOptions })
      return undefined
    }
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      {
        newDocumentState: newDoc({
          id: 'r1',
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes.map(write => write.kind)).toEqual([
      'putContent',
      'putMeta'
    ])
    expect(acks).toStrictEqual([{ id: 'r1', etag: etagFor(1) }])
  })

  it('propagates an onWriteAccepted rejection out of push', async () => {
    // The ack write-back failing rejects the batch, so RxDB re-sends it.
    const port = fakePushPort()
    const push = createPushHandler({
      port,
      onWriteAccepted: async () => {
        throw new Error('write-back torn')
      }
    })

    await expect(
      push([{ newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }])
    ).rejects.toThrow('write-back torn')
    expect(port.writes).toEqual([
      { kind: 'putContent', id: 'r1', data: { a: 1 }, ifNoneMatch: true }
    ])
  })

  it('does not report an ack for a rejected write', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary: {
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        deleted: false,
        data: { a: 9 }
      }
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(conflicts).toHaveLength(1)
    expect(acks).toEqual([])
  })

  it('keeps the content ack when the following metadata write 412s', async () => {
    // The content half was ACCEPTED (the server holds the new content) before
    // the /meta half conflicted. Discarding that ack would leave the local row
    // holding the pre-write validator and 412 on every later conditional
    // write, so the conflict and the ack are reported together.
    const port = fakePushPort({
      conflictOn: { kind: 'putMeta', id: 'r1' },
      primary: {
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        meta: metaStamp(),
        deleted: false,
        data: { a: 2 },
        custom: { jwe: 'srv' }
      }
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ data: { a: 1 } }),
        newDocumentState: newDoc({
          data: { a: 2 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    expect(port.writes.map(write => write.kind)).toEqual([
      'putContent',
      'putMeta'
    ])
    expect(conflicts).toHaveLength(1)
    expect(acks).toStrictEqual([{ id: 'r1', etag: etagFor(1) }])
  })
})

describe('createPushHandler tombstoned assumed primary', () => {
  // A server treats a tombstone as absent for preconditions: `If-Match`
  // against it is refused whatever validator is sent, `If-None-Match: *`
  // re-creates it. So once RxDB has adopted a tombstone conflict entry (or a
  // feed tombstone) as the assumed primary, the next content write is a create
  // and the next delete is unconditional -- the resurrect-after-remote-delete
  // case converges in one cycle instead of re-issuing `If-Match`.
  it('re-creates with If-None-Match when the assumed primary is a tombstone', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(2),
          _deleted: true
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          etag: etagFor(1),
          data: { a: 2 }
        })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'putContent', id: 'r1', data: { a: 2 }, ifNoneMatch: true }
    ])
    expect(port.getCalls).toEqual([])
    expect(acks).toStrictEqual([{ id: 'r1', etag: etagFor(1) }])
  })

  it('re-creates a tombstone conflict entry that carries no etag', async () => {
    // The entry the plain port's null re-read produces: `id`, `updatedAt`,
    // and `_deleted` only.
    const port = fakePushPort()
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ _deleted: true }),
        newDocumentState: newDoc({
          etag: etagFor(1),
          data: { a: 2 }
        })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'putContent', id: 'r1', data: { a: 2 }, ifNoneMatch: true }
    ])
  })

  it('deletes unconditionally when the assumed primary is a tombstone', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(2),
          _deleted: true
        }),
        newDocumentState: newDoc({ ...contentStamp, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([{ kind: 'deleteContent', id: 'r1' }])
    expect(port.getCalls).toEqual([])
  })
})

describe('createPushHandler metadata 404 corroboration', () => {
  it('resolves as a conflict tombstone when the primary is gone', async () => {
    // Under WAS 404-masking a /meta 404 is ambiguous. An independent re-read
    // says the resource is absent, so this was an ordinary race with a remote
    // delete: report a tombstone conflict (which the conflict handler settles)
    // instead of throwing and wedging the batch. The content ack survives.
    const port = fakePushPort({
      auth404On: { kind: 'putMeta', id: 'r1' },
      primary: null
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ data: { a: 1 } }),
        newDocumentState: newDoc({
          data: { a: 2 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    expect(port.getCalls).toEqual(['r1'])
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00Z',
        _deleted: true
      }
    ])
    expect(acks).toStrictEqual([{ id: 'r1', etag: etagFor(1) }])
  })

  it('resolves as a conflict when the re-read primary is already a tombstone', async () => {
    const port = fakePushPort({
      auth404On: { kind: 'putMeta', id: 'r1' },
      primary: {
        updatedAt: '2026-03-03T00:00:00Z',
        ...contentStamp,
        deleted: true
      }
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ data: { a: 1 } }),
        newDocumentState: newDoc({
          data: { a: 1 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    // A feed tombstone is stamped like any other feed document, and its stamp
    // is carried into the entry.
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-03-03T00:00:00Z',
        ...contentStamp,
        _deleted: true
      }
    ])
  })

  it('propagates the auth error when the corroborating re-read is itself denied', async () => {
    // The feed read is denied too: access really has expired, so the signal
    // must escalate rather than be reinterpreted as a delete race.
    const port = fakePushPort({
      auth404On: { kind: 'putMeta', id: 'r1' },
      getRejectsWith: new WasSyncAuthError(403)
    })
    const push = createPushHandler({ port })

    await expect(
      push([
        {
          assumedMasterState: newDoc({ data: { a: 1 } }),
          newDocumentState: newDoc({
            data: { a: 1 },
            custom: { jwe: 'mine' }
          })
        }
      ])
    ).rejects.toMatchObject({ name: 'WasSyncAuthError', status: 403 })
  })

  it('propagates a non-404 auth error on /meta without a corroborating re-read', async () => {
    // Only a masked 404 is ambiguous. A 403 is an explicit refusal, so it
    // escalates as-is. The scripted absent primary would turn a wrongful
    // re-read into a tombstone conflict and resolve the batch.
    const port = fakePushPort({ primary: null })
    port.putMeta = async metaOptions => {
      port.writes.push({ kind: 'putMeta', ...metaOptions })
      throw new WasSyncAuthError(403)
    }
    const push = createPushHandler({ port })

    await expect(
      push([
        {
          assumedMasterState: newDoc({ data: { a: 1 } }),
          newDocumentState: newDoc({
            data: { a: 1 },
            custom: { jwe: 'mine' }
          })
        }
      ])
    ).rejects.toMatchObject({ name: 'WasSyncAuthError', status: 403 })
    expect(port.getCalls).toEqual([])
  })

  it('resolves a metadata-only edit against a gone primary on the default port', async () => {
    // The default port raises a /meta 404 as the plain not-found signal, not
    // the auth signal. Replica A deleted the resource; this replica edited
    // only its metadata, so no content write runs and the /meta write is the
    // first to learn of the delete. Same corroboration, same tombstone
    // conflict entry -- the batch does not reject.
    const port = fakePushPort({
      notFoundOn: { kind: 'putMeta', id: 'r1' },
      primary: null
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          updatedAt: '2025-12-31T00:00:00Z',
          ...contentStamp,
          etag: etagFor(3),
          data: { a: 1 },
          custom: { jwe: 'theirs' },
          meta: metaStamp(),
          metaEtag: metaEtagFor(1)
        }),
        newDocumentState: newDoc({
          updatedAt: '2026-01-01T00:00:00Z',
          ...contentStamp,
          etag: etagFor(3),
          data: { a: 1 },
          custom: { jwe: 'mine' },
          meta: metaStamp(),
          metaEtag: metaEtagFor(1)
        })
      }
    ])

    expect(port.writes.map(write => write.kind)).toEqual(['putMeta'])
    expect(port.getCalls).toEqual(['r1'])
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00Z',
        _deleted: true
      }
    ])
    expect(acks).toEqual([])
  })

  it.each([
    {
      shape: 'the plain not-found on the default port',
      port: 'notFoundOn' as const,
      expected: { name: 'WasSyncNotFoundError' }
    },
    {
      shape: 'the auth 404',
      port: 'auth404On' as const,
      expected: { name: 'WasSyncAuthError', status: 404 }
    }
  ])(
    'propagates $shape when the primary is alive and readable',
    async ({ port: portShape, expected }) => {
      // The resource exists and the feed serves it, yet its /meta write 404s:
      // the write itself was rejected, so the original signal stands.
      const port = fakePushPort({
        [portShape]: { kind: 'putMeta', id: 'r1' },
        primary: {
          updatedAt: '2026-03-03T00:00:00Z',
          ...contentStamp,
          deleted: false,
          data: { a: 1 }
        }
      })
      const push = createPushHandler({ port })

      await expect(
        push([
          {
            assumedMasterState: newDoc({ data: { a: 1 } }),
            newDocumentState: newDoc({
              data: { a: 1 },
              custom: { jwe: 'mine' }
            })
          }
        ])
      ).rejects.toMatchObject(expected)
      expect(port.getCalls).toEqual(['r1'])
    }
  )
})

/**
 * A deterministic content etag for one feed resource at one stamp counter.
 *
 * @param id {string}
 * @param counter {number}
 * @returns {string}
 */
function feedEtag(id: string, counter: number): string {
  return `"etag-${id}-${counter}"`
}

/**
 * A fake base port over an in-memory changes feed, served whole as one page.
 * `putContent` advances the doc's feed stamp counter and etag (so a re-read
 * sees what an accepted write produced) unless the id is in `conflictContent`;
 * its ack carries the new etag unless `hideContentEtag` is set, which models a
 * write response with no readable `ETag`. `putMeta` conflicts for an id in
 * `conflictMeta`. A `putContent` for an id in `holdContent` waits until a feed
 * walk has read the feed, so the write lands after that walk memoized the
 * pre-write state. `queryCalls` counts feed walks -- what the batch's shared
 * primary-read memo is meant to keep to one.
 */
function fakeFeedBase(options: {
  feed: WireDoc[]
  conflictContent?: string[]
  conflictMeta?: string[]
  holdContent?: string[]
  hideContentEtag?: boolean
}): WasSyncBasePort & { queryCalls: number } {
  const state = { queryCalls: 0 }
  const documents = new Map(options.feed.map(doc => [doc.id, { ...doc }]))
  let releaseHeldContent: () => void = () => {}
  const feedRead = new Promise<void>(resolve => {
    releaseHeldContent = resolve
  })
  return {
    get queryCalls() {
      return state.queryCalls
    },
    async query() {
      state.queryCalls++
      const snapshot = [...documents.values()].map(doc => ({ ...doc }))
      releaseHeldContent()
      return { documents: snapshot, checkpoint: null }
    },
    async putContent({ id, data }) {
      if (options.holdContent?.includes(id)) {
        await feedRead
      }
      if (options.conflictContent?.includes(id)) {
        throw new WasSyncConflictError()
      }
      const current = documents.get(id)
      const updatedAtCounter = (current?.updatedAtCounter ?? 0) + 1
      const etag = feedEtag(id, updatedAtCounter)
      documents.set(id, {
        ...feedDoc(id, updatedAtCounter),
        ...(current?.updatedAt !== undefined && {
          updatedAt: current.updatedAt
        }),
        data
      })
      return options.hideContentEtag === true ? {} : { etag }
    },
    async deleteContent() {
      return undefined
    },
    async putMeta({ id }) {
      if (options.conflictMeta?.includes(id)) {
        throw new WasSyncConflictError()
      }
      return { etag: metaEtagFor(1) }
    }
  }
}

function feedDoc(id: string, counter: number): WireDoc {
  return wire({
    id,
    updatedAt: '2026-02-02T00:00:00Z',
    updatedAtCounter: counter,
    etag: feedEtag(id, counter),
    checkpoint: `cp-${id}-${counter}`
  })
}

describe('createPushHandler batch primary re-reads', () => {
  it('resolves every conflicting row in a batch from a single feed walk', async () => {
    const base = fakeFeedBase({
      feed: [feedDoc('r1', 9), feedDoc('r2', 4)],
      conflictContent: ['r1', 'r2']
    })
    const push = createPushHandler({ port: withFeedPrimaryRead(base) })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) },
      { newDocumentState: newDoc({ id: 'r2', data: { b: 1 } }) }
    ])

    expect(conflicts.map(conflict => [conflict.id, conflict.etag])).toEqual([
      ['r1', feedEtag('r1', 9)],
      ['r2', feedEtag('r2', 4)]
    ])
    // One walk for the batch, not one per conflicting row.
    expect(base.queryCalls).toBe(1)
  })

  it.each([
    { response: 'carries its ETag', hideContentEtag: false },
    { response: 'carries no ETag', hideContentEtag: true }
  ])(
    "reports the state a row's own accepted write produced when its response $response",
    async ({ hideContentEtag }) => {
      // r1 conflicts and walks the feed, memoizing every row it pages past.
      // r2's content write is held until that walk has read the feed, so the
      // memo holds r2 at its pre-write stamp (counter 4). The write is then
      // accepted (counter 5) and only r2's `/meta` write conflicts, so its
      // conflict entry must carry the state that write just produced, never
      // the memo's pre-write state (which is why such a row skips the memo).
      // The bypass keys on the accepted write, not on an acked validator, so a
      // response with no `ETag` re-reads fresh too.
      const base = fakeFeedBase({
        feed: [feedDoc('r1', 9), feedDoc('r2', 4)],
        conflictContent: ['r1'],
        conflictMeta: ['r2'],
        holdContent: ['r2'],
        hideContentEtag
      })
      const push = createPushHandler({ port: withFeedPrimaryRead(base) })

      const conflicts = await push([
        { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) },
        {
          newDocumentState: newDoc({
            id: 'r2',
            data: { b: 1 },
            custom: { c: 1 }
          })
        }
      ])

      expect(
        conflicts.map(conflict => [
          conflict.id,
          conflict.updatedAtCounter,
          conflict.etag
        ])
      ).toEqual([
        ['r1', 9, feedEtag('r1', 9)],
        ['r2', 5, feedEtag('r2', 5)]
      ])
    }
  )

  it('bypasses the batch memo after a hidden-ETag content write although no validator was acked', async () => {
    // The content write is accepted with no `ETag`, so `hasAck` is false, yet
    // the row has written this batch: the `/meta` 412's re-read must not be
    // served from the memo. A row that wrote nothing (its content write 412s)
    // is what the memo is for, and gets it.
    const primary: PrimaryState = {
      updatedAt: '2026-02-02T00:00:00Z',
      ...contentStamp,
      deleted: false,
      data: { a: 2 },
      custom: { jwe: 'srv' }
    }
    const hidden = fakePushPort({
      ackWrites: false,
      conflictOn: { kind: 'putMeta', id: 'r1' },
      primary
    })
    const acks: PushWriteAck[] = []
    const hiddenConflicts = await createPushHandler({
      port: hidden,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })([
      {
        newDocumentState: newDoc({
          id: 'r1',
          data: { a: 2 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    expect(hidden.writes.map(write => write.kind)).toEqual([
      'putContent',
      'putMeta'
    ])
    expect(hiddenConflicts).toHaveLength(1)
    expect(acks).toEqual([])
    expect(hidden.getOptions).toStrictEqual([{ id: 'r1' }])

    const unwritten = fakePushPort({
      ackWrites: false,
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary
    })
    await createPushHandler({ port: unwritten })([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(unwritten.getOptions).toHaveLength(1)
    expect(unwritten.getOptions[0]!.cache).toBeDefined()
  })
})

describe('createPushHandler benign delete retry', () => {
  /**
   * A port whose delete is conditional on the validator the server really
   * holds: a stale `If-Match` is refused with a `412`, and `get` answers the
   * current primary. This is the drift a locally created row sees before its
   * own write is acked or echoes back on a pull.
   */
  function driftingDeletePort({
    serverEtag,
    serverData,
    serverWriterId
  }: {
    serverEtag: string
    serverData: unknown
    serverWriterId?: string
  }): WasSyncPort & { deletes: Array<string | undefined> } {
    const deletes: Array<string | undefined> = []
    return {
      deletes,
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        return { etag: serverEtag }
      },
      async deleteContent({ ifMatch }) {
        deletes.push(ifMatch)
        if (ifMatch !== serverEtag) {
          throw new WasSyncConflictError()
        }
        return undefined
      },
      async putMeta() {
        return undefined
      },
      async get() {
        return {
          etag: serverEtag,
          updatedAt: '2026-02-02T00:00:00Z',
          ...contentStamp,
          data: serverData as never,
          ...(serverWriterId !== undefined && { writerId: serverWriterId })
        }
      }
    }
  }

  it('re-issues a 412-refused delete against the current ETag when the body is unchanged', async () => {
    // The locally assumed validator lags the server's (our own create has not
    // echoed back yet), so the first conditional delete is refused. The body is
    // the same content under a drifted validator, so the delete is re-issued.
    const port = driftingDeletePort({
      serverEtag: etagFor(1),
      serverData: { a: 1 }
    })
    const push = createPushHandler({ port })
    const capture = captureLogger('sync')
    const previous = setLogger(capture.logger)

    try {
      const conflicts = await push([
        {
          assumedMasterState: newDoc({ etag: etagFor(0), data: { a: 1 } }),
          newDocumentState: newDoc({ _deleted: true })
        }
      ])

      // No conflict reported: the resource is gone, under the fresh ETag.
      expect(conflicts).toEqual([])
      expect(port.deletes).toEqual([etagFor(0), etagFor(1)])
      // The re-issue is a swallow point the seam makes visible, at debug.
      expect(capture.events).toHaveLength(1)
      expect(capture.events[0]).toMatchObject({
        level: 'debug',
        msg: 'Delete refused on a drifted validator; re-issuing it',
        data: { id: 'r1', assumedEtag: etagFor(0), etag: etagFor(1) }
      })
      expect(capture.events[0]!.data).not.toHaveProperty('assumedVersion')
      expect(capture.events[0]!.data).not.toHaveProperty('version')
    } finally {
      setLogger(previous)
    }
  })

  it('retries when the re-read body differs from the assumed one only in key order', async () => {
    // `bodiesEqual` is JCS-canonical, so a host that re-serializes the stored
    // body with a different key order does not defeat the retry and leave a
    // retracted resource live on the server.
    const port = driftingDeletePort({
      serverEtag: etagFor(1),
      serverData: { b: { d: 3, c: 2 }, a: 1 }
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          etag: etagFor(0),
          data: { a: 1, b: { c: 2, d: 3 } }
        }),
        newDocumentState: newDoc({ _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.deletes).toEqual([etagFor(0), etagFor(1)])
  })

  it('reports a conflict when a 412-refused delete finds a changed body', async () => {
    const primary: PrimaryState = {
      updatedAt: '2026-02-02T00:00:00Z',
      ...contentStamp,
      etag: etagFor(1),
      data: { a: 99 }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'deleteContent', id: 'r1' },
      primary
    })
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ etag: etagFor(0), data: { a: 1 } }),
        newDocumentState: newDoc({ _deleted: true })
      }
    ])

    // The body really changed remotely, so the delete is not re-issued.
    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: etagFor(0) }
    ])
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        etag: etagFor(1),
        data: { a: 99 },
        _deleted: false
      }
    ])
  })

  it("reports a conflict when the equal body is under another writer's label", async () => {
    // Delete-then-recreate by another writer: on a content-addressed row the
    // re-created body reads back equal, so only the label tells it apart from
    // this replica's own validator drift. The delete is not re-issued.
    const port = driftingDeletePort({
      serverEtag: etagFor(3),
      serverData: { a: 1 },
      serverWriterId: 'writer-b'
    })
    const push = createPushHandler({ port, writerId: 'writer-a' })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ etag: etagFor(1), data: { a: 1 } }),
        newDocumentState: newDoc({ _deleted: true })
      }
    ])

    expect(port.deletes).toEqual([etagFor(1)])
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        etag: etagFor(3),
        data: { a: 1 },
        _deleted: false
      }
    ])
  })

  it('re-issues the delete when the equal body is under its own label', async () => {
    const port = driftingDeletePort({
      serverEtag: etagFor(1),
      serverData: { a: 1 },
      serverWriterId: 'writer-a'
    })
    const push = createPushHandler({ port, writerId: 'writer-a' })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ etag: etagFor(0), data: { a: 1 } }),
        newDocumentState: newDoc({ _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.deletes).toEqual([etagFor(0), etagFor(1)])
  })

  it('falls back to body equality when either side carries no label', async () => {
    // No label injected here, a label on the server: equality decides.
    const unlabeledReplica = driftingDeletePort({
      serverEtag: etagFor(1),
      serverData: { a: 1 },
      serverWriterId: 'writer-b'
    })
    expect(
      await createPushHandler({ port: unlabeledReplica })([
        {
          assumedMasterState: newDoc({ etag: etagFor(0), data: { a: 1 } }),
          newDocumentState: newDoc({ _deleted: true })
        }
      ])
    ).toEqual([])
    expect(unlabeledReplica.deletes).toEqual([etagFor(0), etagFor(1)])

    // A label injected here, none recorded on the server's record.
    const unlabeledServer = driftingDeletePort({
      serverEtag: etagFor(1),
      serverData: { a: 1 }
    })
    expect(
      await createPushHandler({ port: unlabeledServer, writerId: 'writer-a' })([
        {
          assumedMasterState: newDoc({ etag: etagFor(0), data: { a: 1 } }),
          newDocumentState: newDoc({ _deleted: true })
        }
      ])
    ).toEqual([])
    expect(unlabeledServer.deletes).toEqual([etagFor(0), etagFor(1)])
  })

  it('skips a delete with no assumed primary and reports it accepted', async () => {
    // Created and deleted locally before this replica's first push: nothing of
    // this replica's is on the server, while another replica may hold a live
    // resource under the same content-addressed id. No `If-Match` exists for
    // "delete only what I created", so no `DELETE` goes out, no re-read runs,
    // and the row is accepted with no ack (the create path's `If-None-Match`
    // guard, mirrored). The batch's other rows still land.
    const capture = captureLogger('sync')
    const previous = setLogger(capture.logger)
    const port = fakePushPort({
      primary: {
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        data: { a: 1 }
      }
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    try {
      const conflicts = await push([
        { newDocumentState: newDoc({ id: 'never-pushed', _deleted: true }) },
        { newDocumentState: newDoc({ id: 'sibling', data: { a: 1 } }) }
      ])

      expect(conflicts).toEqual([])
      expect(port.writes).toEqual([
        {
          kind: 'putContent',
          id: 'sibling',
          data: { a: 1 },
          ifNoneMatch: true
        }
      ])
      expect(port.getCalls).toEqual([])
      expect(acks).toStrictEqual([{ id: 'sibling', etag: etagFor(1) }])
      // The skip is a swallow point the seam makes visible, at debug.
      expect(capture.events).toHaveLength(1)
      expect(capture.events[0]).toMatchObject({
        level: 'debug',
        data: { id: 'never-pushed' }
      })
    } finally {
      setLogger(previous)
    }
  })
})

describe('createPushHandler delete of an absent resource', () => {
  it('treats a not-found delete as already gone and lets the rest of the batch land', async () => {
    // The default was-client port raises the not-found signal on a delete
    // `404` (only `mapAuthErrors: true` swallows it). A spec-conformant server
    // answers `204` for an authorized delete of an absent resource, so the
    // `404` is a non-idempotent server or a masked authorization refusal;
    // neither advances by retrying, and the batch must complete rather than be
    // re-sent unchanged forever with its other rows never landing.
    const port = fakePushPort({
      notFoundOn: { kind: 'deleteContent', id: 'gone-remotely' }
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler({
      port,
      onWriteAccepted: async ack => {
        acks.push(ack)
      }
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          id: 'gone-remotely',
          ...contentStamp,
          etag: etagFor(2),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({
          id: 'gone-remotely',
          ...contentStamp,
          _deleted: true
        })
      },
      { newDocumentState: newDoc({ id: 'sibling', data: { a: 1 } }) }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'gone-remotely', ifMatch: etagFor(2) },
      {
        kind: 'putContent',
        id: 'sibling',
        data: { a: 1 },
        ifNoneMatch: true
      }
    ])
    // Already gone is the goal state, not a conflict: nothing is re-read.
    expect(port.getCalls).toEqual([])
    // No validator is acked for the absent row; the sibling's create is.
    expect(acks).toStrictEqual([{ id: 'sibling', etag: etagFor(1) }])
  })

  it('treats a not-found on the benign-412 re-issued delete as already gone', async () => {
    // The stale-validator delete 412s, the re-read shows the same body, and
    // the resource vanishes between the re-read and the retry (a delete/delete
    // race). The retry's 404 is the goal state, not an error.
    const deletes: Array<string | undefined> = []
    const port: WasSyncPort = {
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        return {} // never invoked on this delete-only push
      },
      async deleteContent({ ifMatch }) {
        deletes.push(ifMatch)
        if (deletes.length === 1) {
          throw new WasSyncConflictError()
        }
        throw new WasSyncNotFoundError()
      },
      async putMeta() {
        return undefined
      },
      async get() {
        return {
          etag: etagFor(5),
          updatedAt: '2026-02-02T00:00:00Z',
          ...contentStamp,
          data: { a: 1 } as never
        }
      }
    }
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ etag: etagFor(1), data: { a: 1 } }),
        newDocumentState: newDoc({ data: { a: 1 }, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(deletes).toEqual([etagFor(1), etagFor(5)])
  })

  it('matches the not-found signal by name alone, with no status', async () => {
    // A second copy of was-client raises a structurally foreign error; only
    // `name` is matched (invariant 5), and no `status` is consulted.
    const port = fakePushPort()
    port.deleteContent = async deleteOptions => {
      port.writes.push({ kind: 'deleteContent', ...deleteOptions })
      throw { name: 'WasSyncNotFoundError', message: 'foreign 404' }
    }
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          id: 'gone',
          etag: etagFor(1),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({ id: 'gone', _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'gone', ifMatch: etagFor(1) }
    ])
  })

  it('still propagates a non-not-found delete error so RxDB retries the batch', async () => {
    const port = fakePushPort()
    port.deleteContent = async () => {
      throw new Error('network down')
    }
    const push = createPushHandler({ port })

    await expect(
      push([
        {
          assumedMasterState: newDoc({ etag: etagFor(1) }),
          newDocumentState: newDoc({ _deleted: true })
        }
      ])
    ).rejects.toThrow('network down')
  })
})

describe('createPushHandler typed signals from another copy', () => {
  /**
   * The signals a foreign copy of `@interop/was-client` raises: structurally
   * the same error, matched only by `name`. A `WasSyncConflictError` from a
   * second physical copy of the package is not `instanceof` this copy's class,
   * so the push handler matches the name string (the WC-64 rule).
   */
  class ForeignAuthError extends Error {
    status: number
    constructor(status: number) {
      super(`foreign ${status}`)
      this.name = 'WasSyncAuthError'
      this.status = status
    }
  }

  it('routes a conflict signal raised by an unrelated copy to the conflict branch', async () => {
    const foreignConflict = { name: 'WasSyncConflictError', message: '412' }
    const port: WasSyncPort = {
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        throw foreignConflict
      },
      async deleteContent() {
        return undefined
      },
      async putMeta() {
        return undefined
      },
      async get() {
        return {
          updatedAt: '2026-02-02T00:00:00Z',
          ...contentStamp,
          data: { a: 99 } as never
        }
      }
    }
    const push = createPushHandler({ port })

    const conflicts = await push([
      { newDocumentState: newDoc({ data: { a: 1 } }) }
    ])

    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-02-02T00:00:00Z',
        ...contentStamp,
        data: { a: 99 },
        _deleted: false
      }
    ])
  })

  it('corroborates a /meta 404 raised by an unrelated copy', async () => {
    const port: WasSyncPort = {
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        return { etag: etagFor(1) }
      },
      async deleteContent() {
        return undefined
      },
      async putMeta() {
        throw new ForeignAuthError(404)
      },
      async get() {
        return null
      }
    }
    const push = createPushHandler({ port })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ data: { a: 1 } }),
        newDocumentState: newDoc({
          data: { a: 2 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    // The re-read says the resource is gone: an ordinary delete race, reported
    // as a tombstone conflict rather than escalating to "access expired".
    expect(conflicts).toStrictEqual([
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00Z',
        _deleted: true
      }
    ])
  })
})

describe('createPushHandler writer attribution', () => {
  const writerId = 'writer-a'

  it('declares the writerId on a content create and its metadata write', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port, writerId })

    await push([
      {
        newDocumentState: newDoc({
          id: 'r1',
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(port.writes).toEqual([
      {
        kind: 'putContent',
        id: 'r1',
        data: { a: 1 },
        ifNoneMatch: true,
        writerId
      },
      {
        kind: 'putMeta',
        id: 'r1',
        custom: { jwe: 'x' },
        ifNoneMatch: true,
        writerId
      }
    ])
  })

  it('declares the writerId on a content update and a metadata clear', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port, writerId })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(2),
          data: { a: 1 },
          meta: metaStamp(),
          metaEtag: metaEtagFor(1),
          custom: { jwe: 'x' }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          meta: metaStamp(),
          data: { a: 2 }
        })
      }
    ])

    expect(port.writes).toEqual([
      {
        kind: 'putContent',
        id: 'r1',
        data: { a: 2 },
        ifMatch: etagFor(2),
        writerId
      },
      { kind: 'putMeta', id: 'r1', ifMatch: metaEtagFor(1), writerId }
    ])
  })

  it('declares the writerId on a delete', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port, writerId })

    await push([
      {
        assumedMasterState: newDoc({
          ...contentStamp,
          etag: etagFor(3),
          data: { a: 1 }
        }),
        newDocumentState: newDoc({
          ...contentStamp,
          data: { a: 1 },
          _deleted: true
        })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: etagFor(3), writerId }
    ])
  })

  it('declares the writerId on the benign-412 delete re-issue too', async () => {
    const deletes: Array<{ ifMatch?: string; writerId?: string }> = []
    const port: WasSyncPort = {
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        return { etag: etagFor(1) }
      },
      async deleteContent({ ifMatch, writerId: declared }) {
        deletes.push({ ifMatch, writerId: declared })
        if (ifMatch !== etagFor(2)) {
          throw new WasSyncConflictError()
        }
        return undefined
      },
      async putMeta() {
        return undefined
      },
      async get() {
        return {
          etag: etagFor(2),
          updatedAt: '2026-02-02T00:00:00Z',
          ...contentStamp,
          data: { a: 1 }
        }
      }
    }
    const push = createPushHandler({ port, writerId })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ etag: etagFor(1), data: { a: 1 } }),
        newDocumentState: newDoc({ data: { a: 1 }, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(deletes).toEqual([
      { ifMatch: etagFor(1), writerId },
      { ifMatch: etagFor(2), writerId }
    ])
  })

  it('declares no label on any write when no writerId was injected', async () => {
    const port = fakePushPort()
    const push = createPushHandler({ port })

    await push([
      {
        newDocumentState: newDoc({
          id: 'r1',
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      },
      {
        assumedMasterState: newDoc({
          id: 'r2',
          etag: etagFor(1),
          data: { b: 1 }
        }),
        newDocumentState: newDoc({
          id: 'r2',
          data: { b: 1 },
          _deleted: true
        })
      }
    ])

    expect(port.writes.map(write => write.kind).sort()).toEqual([
      'deleteContent',
      'putContent',
      'putMeta'
    ])
    for (const write of port.writes) {
      expect('writerId' in write).toBe(false)
    }
  })
})
