/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Drives the ack write-back through a REAL RxDB collection (memory storage)
 * against a fake port. The write-back adopts an acked `etag` and `metaEtag`
 * into the local row so the next edit conditions on the validator the server
 * last reported, and it patches nothing else: the stamp members reach the row
 * from the feed's echo, never from the ack.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRxDatabase, type RxDatabase } from 'rxdb/plugins/core'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { createWasReplication } from '../../src/wasReplication.js'
import { syncedDocSchema } from '../../src/syncedDocSchema.js'
import type { WasSyncPort, WireDoc } from '../../src/types.js'

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
  contentAck: { etag?: string }
  metaAck: { etag?: string }
}) {
  const doc: WireDoc = {
    id: 'doc-0',
    kind: 'resource',
    contentType: 'application/json',
    _deleted: false,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedAtCounter: 3,
    originId: 'origin-a',
    etag: '"g.3"',
    meta: {
      updatedAt: '2026-01-01T00:00:00Z',
      updatedAtCounter: 2,
      originId: 'origin-b',
      generation: 'gen-1'
    },
    metaEtag: '"m.2"',
    checkpoint: 'opaque:0',
    data: { n: 0 },
    custom: { tag: 'a' }
  }
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
