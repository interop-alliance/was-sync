/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Integration test: drives the driver through a REAL RxDB collection (memory
 * storage) against the stateful in-memory fake server published on the
 * `./testing` subpath, proving the full replication machine -- schema,
 * checkpoint iteration, `deletedField`, push/pull round-trips -- rather than
 * the handlers in isolation.
 */
import { afterEach, describe, it, expect } from 'vitest'
import { createRxDatabase, type RxDatabase } from 'rxdb/plugins/core'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { createWasReplication } from '../../src/wasReplication.js'
import { syncedDocSchema } from '../../src/syncedDocSchema.js'
import { FakeWasServer } from '../../src/testing.js'
import type { Json } from '../../src/types.js'

let db: RxDatabase | undefined

afterEach(async () => {
  if (db) {
    await db.close()
    db = undefined
  }
})

async function openCollection() {
  db = await createRxDatabase({
    name: 'synctest' + Math.floor(performance.now()).toString(36),
    storage: getRxStorageMemory(),
    multiInstance: false
  })
  const { synced } = await db.addCollections({
    synced: {
      schema: syncedDocSchema()
    }
  })
  return synced
}

/**
 * Waits until `predicate` holds, nudging replication and polling. Avoids
 * depending on exact RxDB cycle timing.
 */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  nudge?: () => void
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) {
      return
    }
    nudge?.()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Condition not met within timeout.')
}

describe('WAS replication (RxDB + fake server)', () => {
  it('pushes a locally-inserted document to the server', async () => {
    const collection = await openCollection()
    const server = new FakeWasServer()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: server.port(),
      replicationIdentifier: 'test-push'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-1',
      updatedAt: '000000000001',
      version: 0,
      data: { hello: 'world' }
    })

    await eventually(() => server.has('cid-1'))
    expect(server.dataFor('cid-1')).toEqual({ hello: 'world' })

    await replication.cancel()
  })

  it('pulls a server-side document into the local collection', async () => {
    const collection = await openCollection()
    const server = new FakeWasServer()
    server.seed('cid-remote', { from: 'server' })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: server.port(),
      replicationIdentifier: 'test-pull'
    })
    await replication.awaitInitialReplication()

    const doc = await collection.findOne('cid-remote').exec()
    expect(doc?.toJSON().data).toEqual({ from: 'server' })

    await replication.cancel()
  })

  it('round-trips the key-epoch id: a local epoch-stamped doc pushes and pulls back with it intact', async () => {
    const collection = await openCollection()
    const server = new FakeWasServer()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: server.port(),
      replicationIdentifier: 'test-epoch-roundtrip'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-epoch',
      updatedAt: '000000000001',
      version: 0,
      epoch: 'epoch-1',
      data: { hello: 'world' }
    })

    // Push carries the epoch to the server (its `Key-Epoch` stamp).
    await eventually(
      () => server.epochFor('cid-epoch') === 'epoch-1',
      () => replication.reSync()
    )
    expect(server.dataFor('cid-epoch')).toEqual({ hello: 'world' })

    // ...and the epoch pulls back down the feed onto the local document.
    await eventually(
      async () => {
        const current = await collection.findOne('cid-epoch').exec()
        return current?.toJSON().epoch === 'epoch-1'
      },
      () => replication.reSync()
    )
    const doc = await collection.findOne('cid-epoch').exec()
    expect(doc?.toJSON().epoch).toBe('epoch-1')
  })

  it('replicates an epoch-stamped opaque envelope verbatim with no cipher (locked vault still syncs)', async () => {
    const collection = await openCollection()
    const server = new FakeWasServer()
    // An opaque EDV-style envelope the replicating reader cannot decrypt: the
    // sync layer never touches keys, so it moves the body and its epoch verbatim.
    const envelope: Json = { jwe: { ciphertext: 'opaque', protected: 'hdr' } }
    server.seed('cid-sealed', envelope, 'epoch-7')

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: server.port(),
      replicationIdentifier: 'test-epoch-pull'
    })
    await replication.awaitInitialReplication()

    const doc = await collection.findOne('cid-sealed').exec()
    expect(doc?.toJSON().data).toEqual(envelope)
    expect(doc?.toJSON().epoch).toBe('epoch-7')

    await replication.cancel()
  })

  it('replicates a local delete as a server tombstone', async () => {
    const collection = await openCollection()
    const server = new FakeWasServer()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: server.port(),
      replicationIdentifier: 'test-delete'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-del',
      updatedAt: '000000000001',
      version: 0,
      data: { x: 1 }
    })
    // Wait for the create to fully round-trip: pushed to the server AND the
    // server `version` echoed back locally, so the delete's `If-Match` is not
    // stale (the create-then-immediate-delete race of tension 1).
    await eventually(
      async () => {
        const current = await collection.findOne('cid-del').exec()
        return server.has('cid-del') && (current?.toJSON().version ?? 0) >= 1
      },
      () => replication.reSync()
    )

    const doc = await collection.findOne('cid-del').exec()
    await doc!.remove()

    await eventually(
      () => !server.has('cid-del'),
      () => replication.reSync()
    )
    expect(server.has('cid-del')).toBe(false)

    await replication.cancel()
  })
})
