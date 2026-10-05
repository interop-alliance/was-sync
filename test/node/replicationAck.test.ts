/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Drives the ack write-back through a REAL RxDB collection (memory storage)
 * against a fake port. The write-back adopts an acked `etag` and `metaEtag`
 * into the local row so the next edit conditions on the validator the server
 * last reported. From an ack that also carries the write's stamp (a server
 * answering with a body) it adopts the stamp beside the validator, as a unit:
 * the content ack's triple and `createdBy` onto the row, the `/meta` ack's
 * `meta` onto `meta`, nothing from an ack with no validator, and nothing onto a
 * row that was edited again during the push.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRxDatabase,
  type RxCollection,
  type RxDatabase
} from 'rxdb/plugins/core'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { createWasReplication } from '../../src/wasReplication.js'
import { syncedDocSchema } from '../../src/syncedDocSchema.js'
import type {
  SyncedDoc,
  WasSyncPort,
  WireDoc,
  WriteAck
} from '../../src/types.js'
import { metaStamp, wire } from './fixtures.js'

let db: RxDatabase | undefined

afterEach(async () => {
  await db?.close()
  db = undefined
})

/**
 * A feed holding one live, stamped document with both validators. Every write
 * is accepted and acked with the given validators, and the feed returns
 * nothing after the first page, so no echo can mask what the write-back did.
 */
function ackPort({
  contentAck,
  metaAck
}: {
  contentAck: WriteAck
  metaAck: WriteAck
}) {
  const doc: WireDoc = wire({
    id: 'doc-0',
    updatedAtCounter: 3,
    etag: '"g.3"',
    meta: metaStamp({
      updatedAtCounter: 2,
      originId: 'origin-b',
      generation: 'gen-1'
    }),
    metaEtag: '"m.2"',
    checkpoint: 'opaque:0',
    data: { n: 0 },
    custom: { tag: 'a' }
  })
  return {
    doc,
    async query({ checkpoint }: Parameters<WasSyncPort['query']>[0]) {
      return checkpoint === undefined
        ? { documents: [doc], checkpoint: doc.checkpoint }
        : { documents: [], checkpoint: null }
    },
    putContent: vi.fn<WasSyncPort['putContent']>(async () => contentAck),
    deleteContent: vi.fn<WasSyncPort['deleteContent']>(),
    putMeta: vi.fn<WasSyncPort['putMeta']>(async () => metaAck),
    get: vi.fn<WasSyncPort['get']>()
  } satisfies WasSyncPort & { doc: WireDoc }
}

async function openCollection() {
  db = await createRxDatabase({
    name: `acktest-${randomUUID()}`,
    storage: getRxStorageMemory(),
    multiInstance: false
  })
  const { synced } = await db.addCollections({
    synced: { schema: syncedDocSchema() }
  })
  return synced
}

describe('ack write-back', () => {
  it('patches the content etag and nothing else', async () => {
    const collection = await openCollection()
    const port = ackPort({ contentAck: { etag: '"g.4"' }, metaAck: {} })
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'ack-content'
    })
    await replication.awaitInitialReplication()

    const row = await collection.findOne('doc-0').exec()
    await row!.incrementalPatch({
      data: { n: 1 },
      updatedAt: '2026-01-02T00:00:00Z'
    })
    const edited = (await collection.findOne('doc-0').exec())!.toJSON()
    await replication.awaitInSync()

    const acked = (await collection.findOne('doc-0').exec())!
    expect(acked.toJSON()).toEqual({ ...edited, etag: '"g.4"' })
    expect(acked.get('updatedAtCounter')).toBe(3)
    expect(acked.get('originId')).toBe('origin-a')
    expect(acked.get('meta')).toEqual(port.doc.meta)
    expect(acked.get('metaEtag')).toBe('"m.2"')

    await acked.incrementalPatch({
      data: { n: 2 },
      updatedAt: '2026-01-03T00:00:00Z'
    })
    await replication.awaitInSync()
    await replication.cancel()

    expect(port.putContent.mock.calls.map(([call]) => call.ifMatch)).toEqual([
      '"g.3"',
      '"g.4"'
    ])
    // No conflict re-read: neither write was refused.
    expect(port.get).not.toHaveBeenCalled()
  })

  it('patches the metaEtag and nothing else', async () => {
    const collection = await openCollection()
    const port = ackPort({ contentAck: {}, metaAck: { etag: '"m.3"' } })
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'ack-meta'
    })
    await replication.awaitInitialReplication()

    const row = await collection.findOne('doc-0').exec()
    await row!.incrementalPatch({ custom: { tag: 'b' } })
    const edited = (await collection.findOne('doc-0').exec())!.toJSON()
    await replication.awaitInSync()

    const acked = (await collection.findOne('doc-0').exec())!
    expect(acked.toJSON()).toEqual({ ...edited, metaEtag: '"m.3"' })
    expect(acked.get('updatedAtCounter')).toBe(3)
    expect(acked.get('originId')).toBe('origin-a')
    expect(acked.get('meta')).toEqual(port.doc.meta)
    expect(acked.get('etag')).toBe('"g.3"')

    await acked.incrementalPatch({ custom: { tag: 'c' } })
    await replication.awaitInSync()
    await replication.cancel()

    expect(port.putMeta.mock.calls.map(([call]) => call.ifMatch)).toEqual([
      '"m.2"',
      '"m.3"'
    ])
    expect(port.putContent).not.toHaveBeenCalled()
    expect(port.get).not.toHaveBeenCalled()
  })

  it('patches nothing for an ack with no validator', async () => {
    const collection = await openCollection()
    const port = ackPort({ contentAck: {}, metaAck: {} })
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'ack-none'
    })
    await replication.awaitInitialReplication()

    const row = await collection.findOne('doc-0').exec()
    await row!.incrementalPatch({
      data: { n: 1 },
      updatedAt: '2026-01-02T00:00:00Z'
    })
    const edited = (await collection.findOne('doc-0').exec())!.toJSON()
    await replication.awaitInSync()

    const acked = (await collection.findOne('doc-0').exec())!
    expect(port.putContent).toHaveBeenCalledTimes(1)
    expect(acked.toJSON()).toEqual(edited)

    await acked.incrementalPatch({
      data: { n: 2 },
      updatedAt: '2026-01-03T00:00:00Z'
    })
    await replication.awaitInSync()
    await replication.cancel()

    // The row kept the validator it held, so the next write conditions on it.
    expect(port.putContent.mock.calls.map(([call]) => call.ifMatch)).toEqual([
      '"g.3"',
      '"g.3"'
    ])
  })
})

/**
 * Runs one local edit of `doc-0` through replication against `port`: opens a
 * collection, pulls the fixture row, applies `edit`, pushes it, lets the
 * write-back's own push cycle run, and cancels. Returns the collection, the
 * row as edited, and the row as the write-back left it.
 */
async function pushEdit({
  port,
  replicationIdentifier,
  edit,
  beforeStart = () => {}
}: {
  port: WasSyncPort
  replicationIdentifier: string
  edit: Partial<SyncedDoc>
  beforeStart?: (collection: RxCollection<SyncedDoc>) => void
}) {
  const collection = await openCollection()
  beforeStart(collection)
  const replication = createWasReplication({
    rxCollection: collection,
    wasPort: port,
    replicationIdentifier
  })
  await replication.awaitInitialReplication()

  const row = await collection.findOne('doc-0').exec()
  await row!.incrementalPatch(edit)
  const edited = (await collection.findOne('doc-0').exec())!.toJSON()
  await replication.awaitInSync()
  // One more cycle, for the push the write-back's own patch triggers.
  await replication.awaitInSync()
  await replication.cancel()
  const acked = (await collection.findOne('doc-0').exec())!.toJSON()
  return { collection, edited, acked }
}

describe('ack write-back: the acked state beside the validator', () => {
  it('stamps the content ack as a unit beside the etag: the triple and createdBy', async () => {
    const port = ackPort({
      contentAck: {
        etag: '"g.4"',
        updatedAt: '2026-01-02T00:00:00.500Z',
        updatedAtCounter: 4,
        originId: 'origin-a',
        createdBy: 'did:key:z6MkCreator'
      },
      metaAck: {}
    })
    const { edited, acked } = await pushEdit({
      port,
      replicationIdentifier: 'ack-content-stamp',
      edit: { data: { n: 1 }, updatedAt: '2026-01-02T00:00:00Z' }
    })

    expect(acked).toEqual({
      ...edited,
      etag: '"g.4"',
      updatedAt: '2026-01-02T00:00:00.500Z',
      updatedAtCounter: 4,
      originId: 'origin-a',
      createdBy: 'did:key:z6MkCreator'
    })
    // The `/meta` half is untouched by a content ack.
    expect(acked.meta).toEqual(port.doc.meta)
    expect(acked.metaEtag).toBe('"m.2"')
    // The write-back's own patch triggers one more push cycle that finds
    // nothing to write: one content write in all.
    expect(port.putContent).toHaveBeenCalledTimes(1)
  })

  it("stamps meta from the /meta ack and ignores that ack's copy of the content stamp", async () => {
    const newMeta = metaStamp({
      updatedAt: '2026-01-02T00:00:00.700Z',
      updatedAtCounter: 0,
      originId: 'origin-b',
      generation: 'gen-1'
    })
    const port = ackPort({
      contentAck: {},
      metaAck: {
        etag: '"m.3"',
        // The body of a `/meta` write carries the content stamp too; the unit
        // rule keeps it off the row.
        updatedAt: '2026-01-02T00:00:00.700Z',
        updatedAtCounter: 9,
        originId: 'origin-z',
        meta: newMeta
      }
    })
    const { edited, acked } = await pushEdit({
      port,
      replicationIdentifier: 'ack-meta-stamp',
      edit: { custom: { tag: 'b' } }
    })

    expect(acked).toEqual({ ...edited, metaEtag: '"m.3"', meta: newMeta })
    expect(acked.updatedAtCounter).toBe(3)
    expect(acked.originId).toBe('origin-a')
  })

  it('stamps nothing from an ack that carries a stamp but no validator', async () => {
    const port = ackPort({
      contentAck: {
        updatedAt: '2026-01-02T00:00:00.500Z',
        updatedAtCounter: 4,
        originId: 'origin-a',
        createdBy: 'did:key:z6MkCreator'
      },
      metaAck: {}
    })
    const { edited, acked } = await pushEdit({
      port,
      replicationIdentifier: 'ack-stamp-no-validator',
      edit: { data: { n: 1 }, updatedAt: '2026-01-02T00:00:00Z' }
    })

    expect(port.putContent).toHaveBeenCalledTimes(1)
    expect(acked).toEqual(edited)
  })

  /**
   * A port whose first content write lands `concurrentEdit` on the row while
   * the push is in flight, then acks a stamp for the superseded state; the
   * second push (of that edit) is acked on the validator alone.
   */
  function editDuringPushPort(concurrentEdit: Partial<SyncedDoc>) {
    const port = ackPort({ contentAck: { etag: '"g.4"' }, metaAck: {} })
    return {
      port,
      beforeStart(collection: RxCollection<SyncedDoc>) {
        port.putContent.mockImplementationOnce(async () => {
          const row = await collection.findOne('doc-0').exec()
          await row!.incrementalPatch(concurrentEdit)
          return {
            etag: '"g.4"',
            updatedAt: '2026-01-02T00:00:00.500Z',
            updatedAtCounter: 4,
            originId: 'origin-a'
          }
        })
      }
    }
  }

  it('leaves the stamp of a row edited again during the push, and still patches the etag', async () => {
    const { port, beforeStart } = editDuringPushPort({
      data: { n: 2 },
      updatedAt: '2026-01-03T00:00:00Z'
    })
    const { acked } = await pushEdit({
      port,
      replicationIdentifier: 'ack-edited-during-push',
      edit: { data: { n: 1 }, updatedAt: '2026-01-02T00:00:00Z' },
      beforeStart
    })

    expect(acked.updatedAt).toBe('2026-01-03T00:00:00Z')
    expect(acked.data).toEqual({ n: 2 })
    // The validator landed on the edited row regardless.
    expect(acked.etag).toBe('"g.4"')
    expect(port.putContent).toHaveBeenCalledTimes(2)
    // The first ack's stamp was for the superseded state, so the row keeps
    // the stamp it held.
    expect(acked.updatedAtCounter).toBe(3)
  })

  it('leaves the stamp of a row edited during the push without moving updatedAt', async () => {
    // The edit keeps the pushed `updatedAt` and changes only the body, so a
    // guard on `updatedAt` alone would stamp the edited row with the
    // superseded write's server state.
    const { port, beforeStart } = editDuringPushPort({ data: { n: 2 } })
    const { acked } = await pushEdit({
      port,
      replicationIdentifier: 'ack-edited-same-updated-at',
      edit: { data: { n: 1 }, updatedAt: '2026-01-02T00:00:00Z' },
      beforeStart
    })

    expect(acked.data).toEqual({ n: 2 })
    expect(acked.updatedAt).toBe('2026-01-02T00:00:00Z')
    expect(acked.updatedAtCounter).toBe(3)
    expect(acked.etag).toBe('"g.4"')
    expect(port.putContent).toHaveBeenCalledTimes(2)
  })

  it('skips a meta stamp longer than the schema allows and still patches metaEtag', async () => {
    const port = ackPort({
      contentAck: { etag: '"g.4"' },
      metaAck: {
        etag: '"m.3"',
        meta: metaStamp({
          updatedAtCounter: 3,
          originId: 'origin-a',
          generation: 'g'.repeat(65)
        })
      }
    })
    const { acked } = await pushEdit({
      port,
      replicationIdentifier: 'ack-overlong-meta',
      edit: { custom: { tag: 'b' }, updatedAt: '2026-01-02T00:00:00Z' }
    })

    expect(acked.metaEtag).toBe('"m.3"')
    expect(acked.meta).toEqual(port.doc.meta)
  })

  it('skips a member longer than the schema allows and still patches the validators', async () => {
    const port = ackPort({
      contentAck: {
        etag: '"g.4"',
        updatedAt: '2026-01-02T00:00:00.500Z',
        updatedAtCounter: 4,
        originId: 'origin-a',
        createdBy: 'did:key:' + 'z'.repeat(300)
      },
      metaAck: {}
    })
    const { acked } = await pushEdit({
      port,
      replicationIdentifier: 'ack-overlong',
      edit: { data: { n: 1 }, updatedAt: '2026-01-02T00:00:00Z' }
    })

    expect(acked.etag).toBe('"g.4"')
    expect(acked.updatedAtCounter).toBe(4)
    expect(acked.createdBy).toBeUndefined()
  })
})
