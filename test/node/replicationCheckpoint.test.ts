/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Drives the driver through a REAL RxDB collection (memory storage) against a
 * fake port that issues opaque STRING checkpoints over several pages. RxDB
 * stacks checkpoints with `Object.assign` and persists the result in its
 * replication meta, so this is the layer that would scatter a bare string into
 * index-keyed characters; the test holds that the port gets each checkpoint
 * back verbatim, across a pull cycle and across a fresh replication over the
 * same persisted meta.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRxDatabase, type RxDatabase } from 'rxdb/plugins/core'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { WasSyncCheckpointError } from '@interop/was-client/sync'
import { createWasReplication } from '../../src/wasReplication.js'
import { syncedDocSchema } from '../../src/syncedDocSchema.js'
import type { SyncCheckpoint, WasSyncPort, WireDoc } from '../../src/types.js'

let db: RxDatabase | undefined

afterEach(async () => {
  await db?.close()
  db = undefined
})

/**
 * A feed of `count` documents in one fixed order, each carrying the opaque
 * checkpoint that resumes right after it. Pages are served from the position
 * the presented checkpoint names, as a server would.
 */
function fakeFeedPort(count: number): WasSyncPort & {
  calls: Array<{ checkpoint?: SyncCheckpoint; limit: number }>
} {
  const docs: WireDoc[] = Array.from({ length: count }, (_, index) => ({
    id: `doc-${index}`,
    _deleted: false,
    updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
    kind: 'resource',
    contentType: 'application/json',
    updatedAtCounter: 0,
    originId: 'origin-a',
    checkpoint: `opaque:${index}`,
    data: { index }
  }))
  const calls: Array<{ checkpoint?: SyncCheckpoint; limit: number }> = []
  return {
    calls,
    async query(options) {
      calls.push(options)
      let start = 0
      if (options.checkpoint !== undefined) {
        const after = docs.findIndex(
          doc => doc.checkpoint === options.checkpoint
        )
        if (after === -1) {
          throw new WasSyncCheckpointError()
        }
        start = after + 1
      }
      const page = docs.slice(start, start + options.limit)
      return { documents: page, checkpoint: page.at(-1)?.checkpoint ?? null }
    },
    putContent: vi.fn(),
    deleteContent: vi.fn(),
    putMeta: vi.fn(),
    get: vi.fn()
  }
}

async function openCollection() {
  db = await createRxDatabase({
    name: `cptest-${randomUUID()}`,
    storage: getRxStorageMemory(),
    multiInstance: false
  })
  const { synced } = await db.addCollections({
    synced: { schema: syncedDocSchema() }
  })
  return synced
}

describe('opaque string checkpoints through RxDB', () => {
  it('echoes each page checkpoint back verbatim across a multi-page pull', async () => {
    const collection = await openCollection()
    const port = fakeFeedPort(7)

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'string-checkpoints',
      batchSize: 3,
      live: false
    })
    await replication.awaitInitialReplication()
    await replication.cancel()

    expect((await collection.find().exec()).length).toBe(7)
    expect(port.calls.map(call => call.checkpoint)).toEqual([
      undefined,
      'opaque:2',
      'opaque:5'
    ])
  })

  it('resumes a fresh replication from the persisted string checkpoint', async () => {
    const collection = await openCollection()
    const port = fakeFeedPort(4)

    const first = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'string-checkpoints-resume',
      batchSize: 10,
      live: false
    })
    await first.awaitInitialReplication()
    await first.cancel()
    expect(port.calls.map(call => call.checkpoint)).toEqual([undefined])

    // Same identifier and collection: RxDB resumes from the meta it persisted,
    // which must hand the pull handler the string the server issued.
    const second = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'string-checkpoints-resume',
      batchSize: 10,
      live: false
    })
    await second.awaitInitialReplication()
    await second.cancel()

    expect(port.calls.at(-1)?.checkpoint).toBe('opaque:3')
  })
})
