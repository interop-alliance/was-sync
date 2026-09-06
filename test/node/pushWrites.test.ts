/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the push side of the sync adapter (conditional-write routing
 * and the 412 conflict assembler), driven by a fake WAS port -- no server, no
 * RxDB engine.
 */
import { describe, it, expect } from 'vitest'

import {
  WasSyncAuthError,
  WasSyncConflictError,
  WasSyncNotFoundError,
  formatEtag
} from '@interop/was-client/sync'
import { createPushHandler, type PushWriteAck } from '../../src/pushWrites.js'
import { withFeedPrimaryRead } from '../../src/feedPrimaryPort.js'
import type {
  PrimaryState,
  SyncedDoc,
  WasSyncBasePort,
  WasSyncPort,
  WireDoc,
  WithDeleted
} from '../../src/types.js'

type WriteCall =
  | {
      kind: 'putContent'
      id: string
      data: unknown
      ifMatch?: string
      ifNoneMatch?: boolean
      epoch?: string
    }
  | { kind: 'deleteContent'; id: string; ifMatch?: string }
  | {
      kind: 'putMeta'
      id: string
      custom?: unknown
      ifMatch?: string
      ifNoneMatch?: boolean
    }

/**
 * A fake port that records every write VERBATIM (each recorded call spreads the
 * options object it received, so an absent member -- a cleared `custom`, an
 * absent `epoch` -- is genuinely absent from the record and testable with
 * `in`), optionally throws a conflict, a not-found signal, or a masked-404 auth
 * error for a chosen (kind,id), serves a scripted `get` primary state (or a scripted `get`
 * rejection) for the re-read, and acks writes like a versioning server: each
 * accepted content write returns the next content version, each accepted meta
 * write the next metaVersion (starting at 1, like the reference server's
 * create). `ackWrites: false` models a server that exposes no ETag on write
 * responses (e.g. cross-origin without `Access-Control-Expose-Headers`).
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
): WasSyncPort & { writes: WriteCall[]; getCalls: string[] } {
  const ackWrites = options.ackWrites ?? true
  const writes: WriteCall[] = []
  const getCalls: string[] = []
  const versions = new Map<string, number>()
  const metaVersions = new Map<string, number>()
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
  const bump = (revisions: Map<string, number>, id: string) => {
    const next = (revisions.get(id) ?? 0) + 1
    revisions.set(id, next)
    return ackWrites ? next : undefined
  }
  return {
    writes,
    getCalls,
    async query() {
      return { documents: [], checkpoint: null }
    },
    async putContent(putOptions) {
      writes.push({ kind: 'putContent', ...putOptions })
      maybeReject('putContent', putOptions.id)
      return bump(versions, putOptions.id)
    },
    async deleteContent(deleteOptions) {
      writes.push({ kind: 'deleteContent', ...deleteOptions })
      maybeReject('deleteContent', deleteOptions.id)
      // Like the reference server: a DELETE 204 carries no ETag.
      bump(versions, deleteOptions.id)
      return undefined
    },
    async putMeta(metaOptions) {
      writes.push({ kind: 'putMeta', ...metaOptions })
      maybeReject('putMeta', metaOptions.id)
      return bump(metaVersions, metaOptions.id)
    },
    async get({ id }) {
      getCalls.push(id)
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
    version: 0,
    _deleted: false,
    ...over
  }
}

describe('createPushHandler routing', () => {
  it('creates content with If-None-Match when there is no assumed primary', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

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
    const push = createPushHandler(port)

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

  it('updates content with If-Match "<version>" when the body changed', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({ version: 5, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 5, data: { a: 2 } })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'putContent', id: 'r1', data: { a: 2 }, ifMatch: formatEtag(5) }
    ])
  })

  it('routes a metadata-only change to /meta with If-Match "<metaVersion>", no content write', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({
          version: 5,
          metaVersion: 2,
          data: { a: 1 },
          custom: { jwe: 'old' }
        }),
        newDocumentState: newDoc({
          version: 5,
          metaVersion: 2,
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
        ifMatch: formatEtag(2)
      }
    ])
  })

  it('creates metadata with If-None-Match when the primary has no metaVersion yet', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({ version: 5, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 5,
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
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({
          version: 5,
          metaVersion: 2,
          data: { a: 1, b: 2 },
          custom: { jwe: 'x', tag: 'y' }
        }),
        newDocumentState: newDoc({
          version: 5,
          metaVersion: 2,
          data: { b: 2, a: 1 },
          custom: { tag: 'y', jwe: 'x' }
        })
      }
    ])

    expect(port.writes).toEqual([])
  })

  it('deletes with If-Match "<version>" and skips any metadata write', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({ version: 7, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 7,
          _deleted: true,
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: formatEtag(7) }
    ])
  })

  it('writes the cleared metadata state when custom is removed', async () => {
    // A metadata CLEAR: the new state carries no `custom` while the assumed
    // primary does. It must reach /meta as a write with NO `custom` member (the
    // server's replace clears what the body omits), not be skipped -- otherwise
    // the removal never replicates.
    const port = fakePushPort()
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          version: 5,
          metaVersion: 2,
          data: { a: 1 },
          custom: { jwe: 'old' }
        }),
        newDocumentState: newDoc({
          version: 5,
          metaVersion: 2,
          data: { a: 1 }
        })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'putMeta', id: 'r1', ifMatch: formatEtag(2) }
    ])
    expect('custom' in port.writes[0]!).toBe(false)
  })

  it('sends the row epoch on the content write, and nothing when it has none', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

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
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({ version: 5, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 5, data: { a: 2 }, epoch: 'e2' })
      }
    ])

    expect(port.writes).toEqual([
      {
        kind: 'putContent',
        id: 'r1',
        data: { a: 2 },
        epoch: 'e2',
        ifMatch: formatEtag(5)
      }
    ])
  })
})

describe('createPushHandler conflicts', () => {
  it('re-reads and returns the primary state on a 412', async () => {
    const primary: PrimaryState = {
      version: 9,
      updatedAt: '2026-02-02T00:00:00Z',
      deleted: false,
      data: { a: 99 }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(port.getCalls).toEqual(['r1'])
    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-02-02T00:00:00Z',
        version: 9,
        data: { a: 99 },
        _deleted: false
      }
    ])
  })

  it('synthesizes a tombstone conflict when the resource is now absent', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'deleteContent', id: 'r1' },
      primary: null
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 4, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 4, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00Z',
        version: 4,
        _deleted: true
      }
    ])
  })

  it('carries metaVersion/custom into the assembled conflict', async () => {
    const primary: PrimaryState = {
      version: 3,
      metaVersion: 6,
      updatedAt: '2026-03-03T00:00:00Z',
      deleted: false,
      data: { a: 1 },
      custom: { jwe: 'srv' }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'putMeta', id: 'r1' },
      primary
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          version: 3,
          metaVersion: 5,
          data: { a: 1 },
          custom: { jwe: 'old' }
        }),
        newDocumentState: newDoc({
          version: 3,
          metaVersion: 5,
          data: { a: 1 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    expect(conflicts[0]).toMatchObject({
      id: 'r1',
      version: 3,
      metaVersion: 6,
      custom: { jwe: 'srv' },
      _deleted: false
    })
  })

  it('carries the server-managed createdBy into the assembled conflict', async () => {
    const primary: PrimaryState = {
      version: 9,
      updatedAt: '2026-02-02T00:00:00Z',
      createdBy: 'did:key:z6MkCreator',
      data: { a: 99 }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(conflicts[0]).toMatchObject({
      id: 'r1',
      version: 9,
      createdBy: 'did:key:z6MkCreator',
      _deleted: false
    })
  })

  it('carries the primary key epoch into the assembled conflict', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary: {
        version: 9,
        updatedAt: '2026-02-02T00:00:00Z',
        deleted: false,
        data: { a: 99 },
        epoch: 'e3'
      }
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 }, epoch: 'e2' }) }
    ])

    expect(conflicts[0]).toMatchObject({ id: 'r1', version: 9, epoch: 'e3' })
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
    const push = createPushHandler(port)

    await expect(
      push([{ newDocumentState: newDoc({ data: { a: 1 } }) }])
    ).rejects.toThrow('network down')
  })

  it('processes multiple rows and returns only the conflicting ones', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'bad' },
      primary: {
        version: 1,
        updatedAt: '2026-01-05T00:00:00Z',
        deleted: false,
        data: { server: true }
      }
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'ok', data: { a: 1 } }) },
      { newDocumentState: newDoc({ id: 'bad', data: { a: 2 } }) }
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.id).toBe('bad')
  })
})

describe('createPushHandler write acks', () => {
  it('reports the acked content version on a create', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(conflicts).toEqual([])
    expect(acks).toEqual([{ id: 'r1', version: 1 }])
  })

  it('uses the acked version on the next update push (no 412 in steady state)', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    // Create: server acks version 1; the caller writes it back into the row,
    // so the next push's assumed primary carries version 1.
    await push([{ newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }])
    expect(acks).toEqual([{ id: 'r1', version: 1 }])

    // Steady-state update: If-Match uses the acked version, no conflict.
    const conflicts = await push([
      {
        assumedMasterState: newDoc({ id: 'r1', version: 1, data: { a: 1 } }),
        newDocumentState: newDoc({ id: 'r1', version: 1, data: { a: 2 } })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes[1]).toEqual({
      kind: 'putContent',
      id: 'r1',
      data: { a: 2 },
      ifMatch: formatEtag(1)
    })
    expect(acks[1]).toEqual({ id: 'r1', version: 2 })
  })

  it('reports the acked metaVersion on a metadata write', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    await push([
      {
        assumedMasterState: newDoc({ version: 1, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 1,
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(acks).toEqual([{ id: 'r1', metaVersion: 1 }])
  })

  it('does not report an ack for a delete whose response carries no ETag', async () => {
    const port = fakePushPort()
    const acks: PushWriteAck[] = []
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 1, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 1, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(acks).toEqual([])
  })

  it('does not report an ack when the server exposes no write ETags', async () => {
    const port = fakePushPort({ ackWrites: false })
    const acks: PushWriteAck[] = []
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    await push([{ newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }])

    expect(acks).toEqual([])
  })

  it('does not report an ack for a rejected write', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      primary: {
        version: 2,
        updatedAt: '2026-02-02T00:00:00Z',
        deleted: false,
        data: { a: 9 }
      }
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(conflicts).toHaveLength(1)
    expect(acks).toEqual([])
  })

  it('keeps the content ack when the following metadata write 412s', async () => {
    // The content half was ACCEPTED (the server holds the new version) before
    // the /meta half conflicted. Discarding that ack would leave the local row
    // one revision behind and 412 on every later conditional write, so the
    // conflict and the ack are reported together.
    const port = fakePushPort({
      conflictOn: { kind: 'putMeta', id: 'r1' },
      primary: {
        version: 1,
        metaVersion: 4,
        updatedAt: '2026-02-02T00:00:00Z',
        deleted: false,
        data: { a: 2 },
        custom: { jwe: 'srv' }
      }
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 0,
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
    expect(acks).toEqual([{ id: 'r1', version: 1 }])
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
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 0,
          data: { a: 2 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    expect(port.getCalls).toEqual(['r1'])
    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00Z',
        version: 1,
        _deleted: true
      }
    ])
    expect(acks).toEqual([{ id: 'r1', version: 1 }])
  })

  it('resolves as a conflict when the re-read primary is already a tombstone', async () => {
    const port = fakePushPort({
      auth404On: { kind: 'putMeta', id: 'r1' },
      primary: {
        version: 8,
        updatedAt: '2026-03-03T00:00:00Z',
        deleted: true
      }
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 0,
          data: { a: 1 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-03-03T00:00:00Z',
        version: 8,
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
    const push = createPushHandler(port)

    await expect(
      push([
        {
          assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
          newDocumentState: newDoc({
            version: 0,
            data: { a: 1 },
            custom: { jwe: 'mine' }
          })
        }
      ])
    ).rejects.toMatchObject({ name: 'WasSyncAuthError', status: 403 })
  })

  it('propagates the original 404 when the primary is alive and readable', async () => {
    // The resource exists and the feed serves it, yet its /meta write 404s:
    // the write itself was rejected, so the auth signal stands.
    const port = fakePushPort({
      auth404On: { kind: 'putMeta', id: 'r1' },
      primary: {
        version: 3,
        updatedAt: '2026-03-03T00:00:00Z',
        deleted: false,
        data: { a: 1 }
      }
    })
    const push = createPushHandler(port)

    await expect(
      push([
        {
          assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
          newDocumentState: newDoc({
            version: 0,
            data: { a: 1 },
            custom: { jwe: 'mine' }
          })
        }
      ])
    ).rejects.toMatchObject({ name: 'WasSyncAuthError', status: 404 })
    expect(port.getCalls).toEqual(['r1'])
  })
})

/**
 * A fake base port over an in-memory changes feed, served whole as one page.
 * `putContent` bumps the doc's feed `version` (so a re-read sees what an
 * accepted write produced) unless the id is in `conflictContent`; `putMeta`
 * conflicts for an id in `conflictMeta`. `queryCalls` counts feed walks --
 * what the batch's shared primary-read memo is meant to keep to one.
 */
function fakeFeedBase(options: {
  feed: WireDoc[]
  conflictContent?: string[]
  conflictMeta?: string[]
}): WasSyncBasePort & { queryCalls: number } {
  const state = { queryCalls: 0 }
  const documents = new Map(options.feed.map(doc => [doc.id, { ...doc }]))
  return {
    get queryCalls() {
      return state.queryCalls
    },
    async query() {
      state.queryCalls++
      return { documents: [...documents.values()], checkpoint: null }
    },
    async putContent({ id, data }) {
      if (options.conflictContent?.includes(id)) {
        throw new WasSyncConflictError()
      }
      const current = documents.get(id)
      const version = (current?.version ?? 0) + 1
      documents.set(id, {
        id,
        _deleted: false,
        updatedAt: current?.updatedAt ?? '2026-01-01T00:00:00Z',
        version,
        data
      })
      return version
    },
    async deleteContent() {
      return undefined
    },
    async putMeta({ id }) {
      if (options.conflictMeta?.includes(id)) {
        throw new WasSyncConflictError()
      }
      return 1
    }
  }
}

function feedDoc(id: string, version: number): WireDoc {
  return { id, _deleted: false, updatedAt: '2026-02-02T00:00:00Z', version }
}

describe('createPushHandler batch primary re-reads', () => {
  it('resolves every conflicting row in a batch from a single feed walk', async () => {
    const base = fakeFeedBase({
      feed: [feedDoc('r1', 9), feedDoc('r2', 4)],
      conflictContent: ['r1', 'r2']
    })
    const push = createPushHandler(withFeedPrimaryRead(base))

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) },
      { newDocumentState: newDoc({ id: 'r2', data: { b: 1 } }) }
    ])

    expect(conflicts.map(conflict => [conflict.id, conflict.version])).toEqual([
      ['r1', 9],
      ['r2', 4]
    ])
    // One walk for the batch, not one per conflicting row.
    expect(base.queryCalls).toBe(1)
  })

  it("reports the version a row's own accepted write produced", async () => {
    // r1 conflicts and walks the feed, memoizing every row it pages past. r2's
    // content write is accepted and only its `/meta` write conflicts, so its
    // conflict entry must carry the version that write just produced -- never a
    // memo of the pre-write state (which is why such a row skips the memo).
    const base = fakeFeedBase({
      feed: [feedDoc('r1', 9), feedDoc('r2', 4)],
      conflictContent: ['r1'],
      conflictMeta: ['r2']
    })
    const push = createPushHandler(withFeedPrimaryRead(base))

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

    expect(conflicts.map(conflict => [conflict.id, conflict.version])).toEqual([
      ['r1', 9],
      ['r2', 5]
    ])
  })
})

describe('createPushHandler benign delete retry', () => {
  /**
   * A port whose delete is conditional on the revision the server really holds:
   * a stale `If-Match` is refused with a `412`, and `get` answers the current
   * primary. This is the drift a locally created row sees before its own write
   * is acked or echoes back on a pull.
   */
  function driftingDeletePort({
    serverVersion,
    serverData
  }: {
    serverVersion: number
    serverData: unknown
  }): WasSyncPort & { deletes: Array<string | undefined> } {
    const deletes: Array<string | undefined> = []
    return {
      deletes,
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        return serverVersion
      },
      async deleteContent({ ifMatch }) {
        deletes.push(ifMatch)
        if (ifMatch !== formatEtag(serverVersion)) {
          throw new WasSyncConflictError()
        }
        return undefined
      },
      async putMeta() {
        return undefined
      },
      async get() {
        return {
          version: serverVersion,
          updatedAt: '2026-02-02T00:00:00Z',
          data: serverData as never
        }
      }
    }
  }

  it('re-issues a 412-refused delete against the current ETag when the body is unchanged', async () => {
    // The locally assumed revision lags the server's (our own create has not
    // echoed back yet), so the first conditional delete is refused. The body is
    // the same content under a drifted revision, so the delete is re-issued.
    const port = driftingDeletePort({ serverVersion: 1, serverData: { a: 1 } })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 0, _deleted: true })
      }
    ])

    // No conflict reported: the resource is gone, under the fresh ETag.
    expect(conflicts).toEqual([])
    expect(port.deletes).toEqual([formatEtag(0), formatEtag(1)])
  })

  it('retries when the re-read body differs from the assumed one only in key order', async () => {
    // `bodiesEqual` is JCS-canonical, so a host that re-serializes the stored
    // body with a different key order does not defeat the retry and leave a
    // retracted resource live on the server.
    const port = driftingDeletePort({
      serverVersion: 1,
      serverData: { b: { d: 3, c: 2 }, a: 1 }
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          version: 0,
          data: { a: 1, b: { c: 2, d: 3 } }
        }),
        newDocumentState: newDoc({ version: 0, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.deletes).toEqual([formatEtag(0), formatEtag(1)])
  })

  it('converges a delete whose push ack write-back was torn', async () => {
    // The ack write-back is best-effort: a create accepted as version 1 whose
    // write-back never lands leaves the local row on version 0. The delete that
    // follows sends the stale `If-Match` and is absorbed by the retry.
    const port = driftingDeletePort({ serverVersion: 1, serverData: { a: 1 } })
    const push = createPushHandler(port, async () => {
      throw new Error('write-back torn')
    })

    await expect(
      push([{ newDocumentState: newDoc({ version: 0, data: { a: 1 } }) }])
    ).rejects.toThrow('write-back torn')

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 0, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.deletes).toEqual([formatEtag(0), formatEtag(1)])
  })

  it('reports a conflict when a 412-refused delete finds a changed body', async () => {
    const primary: PrimaryState = {
      version: 1,
      updatedAt: '2026-02-02T00:00:00Z',
      data: { a: 99 }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'deleteContent', id: 'r1' },
      primary
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 0, _deleted: true })
      }
    ])

    // The body really changed remotely, so the delete is not re-issued.
    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: formatEtag(0) }
    ])
    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-02-02T00:00:00Z',
        version: 1,
        data: { a: 99 },
        _deleted: false
      }
    ])
  })

  it('leaves a 412 with no assumed revision to the conflict path', async () => {
    // Nothing to compare a re-read body against, so the retry never fires.
    const port = fakePushPort({
      conflictOn: { kind: 'deleteContent', id: 'r1' },
      primary: { version: 2, updatedAt: '2026-02-02T00:00:00Z', data: { a: 1 } }
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ _deleted: true }) }
    ])

    expect(port.writes).toEqual([{ kind: 'deleteContent', id: 'r1' }])
    expect(conflicts[0]).toMatchObject({ id: 'r1', version: 2 })
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
      notFoundOn: { kind: 'deleteContent', id: 'never-pushed' }
    })
    const acks: PushWriteAck[] = []
    const push = createPushHandler(port, async ack => {
      acks.push(ack)
    })

    const conflicts = await push([
      {
        newDocumentState: newDoc({ id: 'never-pushed', _deleted: true })
      },
      { newDocumentState: newDoc({ id: 'sibling', data: { a: 1 } }) }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'never-pushed' },
      {
        kind: 'putContent',
        id: 'sibling',
        data: { a: 1 },
        ifNoneMatch: true
      }
    ])
    // No revision is acked for the absent row; the sibling's create is.
    expect(acks).toEqual([{ id: 'sibling', version: 1 }])
  })

  it('treats a not-found delete conditional on an assumed revision as already gone', async () => {
    // Deleted remotely first: the local row still assumes a live primary.
    const port = fakePushPort({
      notFoundOn: { kind: 'deleteContent', id: 'r1' }
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 3, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 3, data: { a: 1 }, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: formatEtag(3) }
    ])
    expect(port.getCalls).toEqual([])
  })

  it('treats a not-found on the benign-412 re-issued delete as already gone', async () => {
    // The stale-revision delete 412s, the re-read shows the same body, and the
    // resource vanishes between the re-read and the retry (a delete/delete
    // race). The retry's 404 is the goal state, not an error.
    const deletes: Array<string | undefined> = []
    const port: WasSyncPort = {
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        return undefined
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
          version: 5,
          updatedAt: '2026-02-02T00:00:00Z',
          data: { a: 1 } as never
        }
      }
    }
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 1, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 1, data: { a: 1 }, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([])
    expect(deletes).toEqual([formatEtag(1), formatEtag(5)])
  })

  it('matches the not-found signal by name alone, with no status', async () => {
    // A second copy of was-client raises a structurally foreign error; only
    // `name` is matched (invariant 5), and no `status` is consulted.
    const port = fakePushPort()
    port.deleteContent = async deleteOptions => {
      port.writes.push({ kind: 'deleteContent', ...deleteOptions })
      throw { name: 'WasSyncNotFoundError', message: 'foreign 404' }
    }
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'gone', _deleted: true }) }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([{ kind: 'deleteContent', id: 'gone' }])
  })

  it('still propagates a non-not-found delete error so RxDB retries the batch', async () => {
    const port = fakePushPort()
    port.deleteContent = async () => {
      throw new Error('network down')
    }
    const push = createPushHandler(port)

    await expect(
      push([{ newDocumentState: newDoc({ id: 'r1', _deleted: true }) }])
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
          version: 9,
          updatedAt: '2026-02-02T00:00:00Z',
          data: { a: 99 } as never
        }
      }
    }
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ data: { a: 1 } }) }
    ])

    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-02-02T00:00:00Z',
        version: 9,
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
        return 1
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
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 0, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 0,
          data: { a: 2 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    // The re-read says the resource is gone: an ordinary delete race, reported
    // as a tombstone conflict rather than escalating to "access expired".
    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00Z',
        version: 1,
        _deleted: true
      }
    ])
  })
})
