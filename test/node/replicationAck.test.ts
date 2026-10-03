/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Drives the ack write-back through a REAL RxDB collection (memory storage)
 * against a fake port whose write acks carry revision `0`. That is what
 * was-client's port resolves when the `ETag` is hidden from a cross-origin
 * caller or carries no parseable revision. The write-back must leave the row's
 * last real revision in place, and the next edit must condition on the
 * validator the row already held.
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
 * A feed holding one live document at content revision 3 and metadata
 * revision 2. Every write is accepted, and each ack reports revision `0`: the
 * content ack with no `etag` (a hidden header), the metadata ack with an
 * `etag` that carries no revision.
 */
function zeroAckPort() {
  const doc: WireDoc = {
    id: 'doc-0',
    _deleted: false,
    updatedAt: '2026-01-01T00:00:00Z',
    version: 3,
    etag: '"g.3"',
    metaVersion: 2,
    metaEtag: '"m.2"',
    checkpoint: 'opaque:0',
    data: { n: 0 },
    custom: { tag: 'a' }
  }
  return {
    async query({ checkpoint }: Parameters<WasSyncPort['query']>[0]) {
      return checkpoint === undefined
        ? { documents: [doc], checkpoint: doc.checkpoint }
        : { documents: [], checkpoint: null }
    },
    putContent: vi.fn<WasSyncPort['putContent']>(async () => ({ version: 0 })),
    deleteContent: vi.fn<WasSyncPort['deleteContent']>(),
    putMeta: vi.fn<WasSyncPort['putMeta']>(async () => ({
      version: 0,
      etag: '"meta-opaque"'
    })),
    get: vi.fn<WasSyncPort['get']>()
  } satisfies WasSyncPort
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

describe('ack write-back of revision 0', () => {
  it('leaves the content version untouched and keeps the next If-Match', async () => {
    const collection = await openCollection()
    const port = zeroAckPort()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'zero-ack-content'
    })
    await replication.awaitInitialReplication()

    const row = await collection.findOne('doc-0').exec()
    await row!.incrementalPatch({
      data: { n: 1 },
      updatedAt: '2026-01-02T00:00:00Z'
    })
    await replication.awaitInSync()

    const acked = await collection.findOne('doc-0').exec()
    expect(acked!.get('version')).toBe(3)
    expect(acked!.get('etag')).toBe('"g.3"')

    await acked!.incrementalPatch({
      data: { n: 2 },
      updatedAt: '2026-01-03T00:00:00Z'
    })
    await replication.awaitInSync()
    await replication.cancel()

    expect(port.putContent).toHaveBeenCalledTimes(2)
    expect(port.putContent.mock.calls.map(([call]) => call.ifMatch)).toEqual([
      '"g.3"',
      '"g.3"'
    ])
    // No conflict re-read: neither write was refused.
    expect(port.get).not.toHaveBeenCalled()
  })

  it('leaves the metaVersion untouched and adopts the acked metaEtag', async () => {
    const collection = await openCollection()
    const port = zeroAckPort()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'zero-ack-meta'
    })
    await replication.awaitInitialReplication()

    const row = await collection.findOne('doc-0').exec()
    await row!.incrementalPatch({ custom: { tag: 'b' } })
    await replication.awaitInSync()

    const acked = await collection.findOne('doc-0').exec()
    expect(acked!.get('metaVersion')).toBe(2)
    expect(acked!.get('metaEtag')).toBe('"meta-opaque"')

    await acked!.incrementalPatch({ custom: { tag: 'c' } })
    await replication.awaitInSync()
    await replication.cancel()

    expect(port.putMeta.mock.calls.map(([call]) => call.ifMatch)).toEqual([
      '"m.2"',
      '"meta-opaque"'
    ])
    expect(port.putContent).not.toHaveBeenCalled()
    expect(port.get).not.toHaveBeenCalled()
  })
})
