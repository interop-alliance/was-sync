/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Integration test: drives the driver through a REAL RxDB collection (memory
 * storage) against a REAL in-process was-teaching-server, over the sync port
 * `@interop/was-client` builds (`createWasSyncPort`, default configuration).
 * It proves the full replication machine -- schema, checkpoint iteration,
 * `deletedField`, push/pull round-trips -- rather than the handlers in
 * isolation, and it does so against the server's actual conditional-write,
 * tombstone, and `changes`-feed behavior rather than a fake's reading of them.
 *
 * One server and one Space serve the whole file; each test provisions its own
 * plaintext collection so no state crosses tests. Server-side observation goes
 * through a second, independent port on the same collection, so an assertion
 * about "what the server holds" never reads through the replica under test.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRxDatabase, type RxDatabase } from 'rxdb/plugins/core'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { openTempBackend, startTestServer } from 'was-teaching-server/testing'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { WasClient } from '@interop/was-client'
import {
  createWasSyncPort,
  deriveSpaceId,
  ensureSpaceAndCollection,
  isSyncConflictError
} from '@interop/was-client/sync'
import { createWasReplication } from '../../src/wasReplication.js'
import { syncedDocSchema } from '../../src/syncedDocSchema.js'
import {
  lwwResolver,
  makeConflictHandler,
  type ConflictInput
} from '../../src/conflictHandler.js'
import type {
  Json,
  SyncedDoc,
  WasSyncPort,
  WithDeleted
} from '../../src/types.js'

// A fixed 32-byte seed so the controller DID, and therefore the Space id, is
// stable across runs; the data directory is fresh each run regardless.
const SEED = new Uint8Array(32).map((_, index) => (index * 31 + 7) & 0xff)

let server: Awaited<ReturnType<typeof startTestServer>>
let was: WasClient
let spaceId: string
let controllerDid: string
let db: RxDatabase | undefined
let collectionSerial = 0

beforeAll(async () => {
  // The server owns the temp backend, so closing it removes the data dir.
  // Zcap invocation targets embed the port, so the client is built from the
  // `serverUrl` the boot returns.
  server = await startTestServer({
    backend: await openTempBackend({
      prefix: 'was-sync-integration-',
      capacityBytes: Infinity
    })
  })
  const { serverUrl } = server

  const keyPair = await Ed25519VerificationKey.generate({ seed: SEED })
  controllerDid = `did:key:${keyPair.fingerprint()}`
  was = WasClient.fromSigner({ serverUrl, signer: keyPair.didKeySigner() })
  spaceId = deriveSpaceId(controllerDid)
})

afterAll(async () => {
  await server.fastify.close()
})

afterEach(async () => {
  if (db) {
    await db.close()
    db = undefined
  }
})

/**
 * Provisions a fresh plaintext collection in the suite's Space and returns two
 * independent ports on it: `port` for the replica under test and `observer`
 * for the test's own reads and seeds.
 */
async function openServerCollection(): Promise<{
  port: WasSyncPort
  observer: WasSyncPort
}> {
  collectionSerial += 1
  const collectionId = `synced-${collectionSerial}`
  await ensureSpaceAndCollection({
    was,
    spaceId,
    controllerDid,
    collectionId,
    encryption: 'plaintext'
  })
  const build = () => createWasSyncPort({ was, spaceId, collectionId })
  return { port: build(), observer: build() }
}

/**
 * Opens a fresh memory-storage collection on the synced-document schema. With
 * `lww` set, the package's last-write-wins conflict handler is installed over
 * plaintext bodies. Otherwise the remote state wins, as under RxDB's default.
 * `onConflict` is called once per conflict RxDB hands the handler, with the
 * conflict input.
 */
async function openCollection({
  lww = false,
  onConflict
}: { lww?: boolean; onConflict?: (input: ConflictInput) => void } = {}) {
  db = await createRxDatabase({
    name: `synctest-${randomUUID()}`,
    storage: getRxStorageMemory(),
    multiInstance: false
  })
  const resolveLww = lwwResolver({ decrypt: async ({ envelope }) => envelope })
  const { synced } = await db.addCollections({
    synced: {
      schema: syncedDocSchema(),
      ...((lww || onConflict !== undefined) && {
        conflictHandler: makeConflictHandler({
          resolve: async input => {
            onConflict?.(input)
            return lww ? resolveLww(input) : 'remote'
          }
        })
      })
    }
  })
  return synced
}

/**
 * Pulls the current test's server collection into a fresh replica of its own
 * and returns the rows it ends up holding, sorted by id. The replica pushes
 * nothing, so every member it holds came down the feed.
 */
async function pullFreshReplica({
  replicationIdentifier,
  writerId
}: {
  replicationIdentifier: string
  writerId?: string
}) {
  const database = await createRxDatabase({
    name: `freshtest-${randomUUID()}`,
    storage: getRxStorageMemory(),
    multiInstance: false
  })
  try {
    const { synced } = await database.addCollections({
      synced: { schema: syncedDocSchema() }
    })
    const replication = createWasReplication({
      rxCollection: synced,
      wasPort: createWasSyncPort({
        was,
        spaceId,
        collectionId: `synced-${collectionSerial}`
      }),
      replicationIdentifier,
      ...(writerId !== undefined && { writerId })
    })
    await replication.awaitInitialReplication()
    await replication.cancel()
    const docs = await synced.find().exec()
    return docs
      .map(doc => doc.toJSON())
      .sort((left, right) => left.id.localeCompare(right.id))
  } finally {
    await database.close()
  }
}

/**
 * The `step` marker of a plaintext body, or `undefined` for anything else.
 */
function stepOf(data: Json | undefined): unknown {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data.step
    : undefined
}

/**
 * Wraps the port's three writes to record the precondition each one carried,
 * so a test can assert the exact conditional-write sequence the driver issued.
 */
function recordPreconditionsOn(port: WasSyncPort): {
  contentWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }>
  metaWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }>
  deleteWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }>
} {
  const contentWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }> = []
  const metaWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }> = []
  const deleteWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }> = []
  const record = (
    into: Array<{ ifMatch?: string; ifNoneMatch?: boolean }>,
    { ifMatch, ifNoneMatch }: { ifMatch?: string; ifNoneMatch?: boolean }
  ) =>
    into.push({
      ...(ifMatch !== undefined && { ifMatch }),
      ...(ifNoneMatch !== undefined && { ifNoneMatch })
    })
  const rawPut = port.putContent.bind(port)
  port.putContent = async options => {
    record(contentWrites, options)
    return rawPut(options)
  }
  const rawPutMeta = port.putMeta.bind(port)
  port.putMeta = async options => {
    record(metaWrites, options)
    return rawPutMeta(options)
  }
  const rawDelete = port.deleteContent.bind(port)
  port.deleteContent = async options => {
    record(deleteWrites, options)
    return rawDelete(options)
  }
  return { contentWrites, metaWrites, deleteWrites }
}

/**
 * Whether the observer's read shows a fully committed record. The server writes
 * a resource's content file before its metadata sidecar, and a read that lands
 * between the two returns the content with no `etag`, write stamp, or
 * `createdBy`; waiting for the `etag` rules that torn read out.
 */
function committed(record: { etag?: string } | null): boolean {
  return record?.etag !== undefined
}

/**
 * Whether a local row holds the server's content write stamp as the observer
 * reads it. The stamp reaches the row from the write ack (the server answers
 * the write with a body) or from the feed echo; either way a row whose pair is
 * defined and equal to the primary's holds the server's state. The top-level
 * `updatedAt` is compared too. The server's value replaces the app's, and the
 * server reuses one origin and often counter `0`, so the pair alone cannot
 * tell the stamp of an edit from the state the row held before it.
 */
function holdsServerStamp(
  local: Pick<SyncedDoc, 'updatedAt' | 'updatedAtCounter' | 'originId'> | null,
  primary: Pick<SyncedDoc, 'updatedAt' | 'updatedAtCounter' | 'originId'> | null
): boolean {
  return (
    local !== null &&
    primary !== null &&
    local.updatedAtCounter !== undefined &&
    local.originId !== undefined &&
    local.updatedAtCounter === primary.updatedAtCounter &&
    local.originId === primary.originId &&
    local.updatedAt === primary.updatedAt
  )
}

/**
 * The current local row of `id` as a plain object, or `null` when the row is
 * absent or deleted.
 */
async function localRow(
  collection: Awaited<ReturnType<typeof openCollection>>,
  id: string
): Promise<WithDeleted<SyncedDoc> | null> {
  const doc = await collection.findOne(id).exec()
  return doc === null ? null : (doc.toJSON() as WithDeleted<SyncedDoc>)
}

/**
 * A nudge that pulls only once every pending push has settled. RxDB drops a
 * pulled state while a local write is pending on the row and still moves the
 * checkpoint on, and the ack write-back is such a write until the push cycle
 * it triggers has run. The ack carries the server state, so a dropped echo
 * costs the row nothing, but a barrier that waits on a member only the echo
 * brings (a feed-only `writerId`, say) would wait for a feed change that never
 * comes.
 */
function settledReSync(replication: {
  awaitInSync(): Promise<boolean>
  reSync(): void
}): () => Promise<void> {
  return async () => {
    await replication.awaitInSync()
    replication.reSync()
  }
}

/**
 * Waits until `predicate` holds, nudging replication and polling. Avoids
 * depending on exact RxDB cycle timing.
 */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  nudge?: () => void | Promise<void>
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) {
      return
    }
    await nudge?.()
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Condition not met within timeout.')
}

describe('WAS replication (RxDB + live was-teaching-server)', () => {
  it('pushes a locally-inserted document to the server', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-push'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-1',
      updatedAt: '000000000001',
      data: { hello: 'world' }
    })

    await eventually(async () => committed(await observer.get({ id: 'cid-1' })))
    const primary = await observer.get({ id: 'cid-1' })
    expect(primary?.data).toEqual({ hello: 'world' })
    expect(primary?.updatedAtCounter).toBeTypeOf('number')
    expect(primary?.originId).toBeTypeOf('string')

    await replication.cancel()
  })

  it('pulls a server-side document into the local collection', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    await observer.putContent({ id: 'cid-remote', data: { from: 'server' } })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-pull'
    })
    await replication.awaitInitialReplication()

    const doc = await collection.findOne('cid-remote').exec()
    expect(doc?.toJSON().data).toEqual({ from: 'server' })

    await replication.cancel()
  })

  it('round-trips the key-epoch id: a local epoch-stamped doc pushes, and a fresh replica pulls it with the epoch intact', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-epoch-roundtrip'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-epoch',
      updatedAt: '000000000001',
      epoch: 'epoch-1',
      data: { hello: 'world' }
    })

    // Push carries the epoch to the server (its `Key-Epoch` stamp).
    await eventually(
      async () =>
        (await observer.get({ id: 'cid-epoch' }))?.epoch === 'epoch-1',
      () => replication.reSync()
    )
    expect((await observer.get({ id: 'cid-epoch' }))?.data).toEqual({
      hello: 'world'
    })

    await replication.cancel()

    // ...and a replica that never held the row pulls the epoch down the feed.
    const pulled = await pullFreshReplica({
      replicationIdentifier: 'test-epoch-roundtrip-fresh'
    })
    expect(pulled.map(doc => [doc.id, doc.epoch])).toEqual([
      ['cid-epoch', 'epoch-1']
    ])
  })

  it('replicates an epoch-stamped opaque envelope verbatim with no cipher (locked vault still syncs)', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    // An opaque EDV-style envelope the replicating reader cannot decrypt: the
    // driver never touches keys, so it moves the body and its epoch verbatim.
    const envelope: Json = { jwe: { ciphertext: 'opaque', protected: 'hdr' } }
    await observer.putContent({
      id: 'cid-sealed',
      data: envelope,
      epoch: 'epoch-7'
    })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
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
    const { port, observer } = await openServerCollection()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-delete'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-del',
      updatedAt: '000000000001',
      data: { x: 1 }
    })
    // Wait for the create's ack write-back: pushed to the server AND the acked
    // `etag` written into the local row, so the delete's `If-Match` is not
    // stale (the create-then-immediate-delete race of tension 1).
    await eventually(
      async () =>
        committed(await observer.get({ id: 'cid-del' })) &&
        (await localRow(collection, 'cid-del'))?.etag !== undefined
    )

    const doc = await collection.findOne('cid-del').exec()
    await doc!.remove()

    // The plain port reads a tombstone as `null`, the same as an absence.
    await eventually(
      async () => (await observer.get({ id: 'cid-del' })) === null,
      () => replication.reSync()
    )
    expect(await observer.get({ id: 'cid-del' })).toBeNull()

    await replication.cancel()
  })

  it("skips a delete of a row it never pushed, leaving another replica's live copy intact", async () => {
    // Ids are content-addressed and identical across replicas. Replica A
    // creates r and pushes it; replica B creates the same r and deletes it
    // before its first push, which RxDB coalesces to a delete with no assumed
    // primary. B holds no server state for r, so the driver sends no `DELETE`
    // (an unconditional one would tombstone A's copy) and the batch's sibling
    // still lands. B's initial pull pages past the live r while the delete is
    // still pending locally (RxDB defers a pulled state behind an un-pushed
    // local change), so B keeps its tombstone until r next changes on the
    // feed; the first such change brings A's live copy down to B.
    const replicaA = await openCollection()
    const { port: portA, observer } = await openServerCollection()
    const replicationA = createWasReplication({
      rxCollection: replicaA,
      wasPort: portA,
      replicationIdentifier: 'test-skip-delete-a'
    })
    await replicationA.awaitInitialReplication()
    await replicaA.insert({
      id: 'cid-shared',
      updatedAt: '000000000001',
      data: { x: 1 }
    })
    await eventually(
      async () => committed(await observer.get({ id: 'cid-shared' })),
      () => replicationA.reSync()
    )
    const live = await observer.get({ id: 'cid-shared' })
    await replicationA.cancel()

    const dbA = db
    db = undefined
    const replicaB = await openCollection()
    const portB = createWasSyncPort({
      was,
      spaceId,
      collectionId: `synced-${collectionSerial}`
    })
    const deletes: string[] = []
    const rawDelete = portB.deleteContent.bind(portB)
    portB.deleteContent = async options => {
      deletes.push(options.id)
      return rawDelete(options)
    }
    await replicaB.insert({
      id: 'cid-shared',
      updatedAt: '000000000001',
      data: { x: 1 }
    })
    await (await replicaB.findOne('cid-shared').exec())!.remove()
    await replicaB.insert({
      id: 'cid-sibling',
      updatedAt: '000000000002',
      data: { x: 2 }
    })

    const replicationB = createWasReplication({
      rxCollection: replicaB,
      wasPort: portB,
      replicationIdentifier: 'test-skip-delete-b'
    })
    const errors: unknown[] = []
    replicationB.error$.subscribe(err => errors.push(err))
    await replicationB.awaitInitialReplication()
    await replicationB.awaitInSync()

    expect(deletes).toEqual([])
    expect(errors).toEqual([])
    // A's copy is intact, under the validator and stamp A's create earned.
    expect(await observer.get({ id: 'cid-shared' })).toEqual(live)
    expect((await observer.get({ id: 'cid-sibling' }))?.data).toEqual({ x: 2 })
    // B holds its local tombstone: the pull that paged past the live r found
    // the delete still pending, and the skip then settled the row as pushed.
    expect(await replicaB.findOne('cid-shared').exec()).toBeNull()

    // The next change to r on the server puts it back on the feed, and B,
    // with nothing pending on the row, adopts A's live copy.
    await observer.putMeta({
      id: 'cid-shared',
      custom: { touched: true },
      ifNoneMatch: true
    })
    await eventually(
      async () => (await replicaB.findOne('cid-shared').exec()) !== null,
      () => replicationB.reSync()
    )
    expect(
      (await replicaB.findOne('cid-shared').exec())?.toJSON().data
    ).toEqual({ x: 1 })

    await replicationB.cancel()
    await dbA?.close()
  })

  it('pulls a server-side tombstone as a local delete', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    const created = await observer.putContent({
      id: 'cid-gone',
      data: { from: 'server' }
    })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-pull-tombstone'
    })
    await replication.awaitInitialReplication()
    expect(await collection.findOne('cid-gone').exec()).not.toBeNull()

    // The other writer deletes it; the tombstone rides the feed down.
    await observer.deleteContent({ id: 'cid-gone', ifMatch: created.etag })
    await eventually(
      async () => (await collection.findOne('cid-gone').exec()) === null,
      () => replication.reSync()
    )

    await replication.cancel()
  })

  it('pulls a feed longer than one page', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    const count = 7
    for (let index = 0; index < count; index++) {
      await observer.putContent({ id: `cid-page-${index}`, data: { index } })
    }

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-paging',
      batchSize: 3
    })
    await replication.awaitInitialReplication()
    await eventually(
      async () => (await collection.find().exec()).length === count,
      () => replication.reSync()
    )

    const docs = await collection.find().exec()
    expect(docs.map(doc => doc.toJSON().id).sort()).toEqual(
      Array.from({ length: count }, (_, index) => `cid-page-${index}`).sort()
    )

    await replication.cancel()
  })

  it('stamps the server-assigned createdBy on a pushed document', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-created-by'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-author',
      updatedAt: '000000000001',
      data: { hello: 'world' }
    })
    await eventually(async () =>
      committed(await observer.get({ id: 'cid-author' }))
    )

    const primary = await observer.get({ id: 'cid-author' })
    expect(primary?.createdBy).toBe(controllerDid)

    // The server answers the write with a body, so the ack write-back stamps
    // `createdBy` and the write stamp beside `etag`. A pull nudged while the
    // push may still be in flight is harmless: whether RxDB writes the echo or
    // drops it behind the pending write-back, the row ends up holding the
    // server's state.
    replication.reSync()
    await replication.awaitInSync()
    const local = (await collection.findOne('cid-author').exec())?.toJSON()
    expect(local?.createdBy).toBe(controllerDid)
    expect(local?.updatedAt).toBe(primary?.updatedAt)
    expect(local?.updatedAtCounter).toBe(primary?.updatedAtCounter)
    expect(local?.originId).toBe(primary?.originId)
    expect(local?.etag).toBe(primary?.etag)

    await replication.cancel()
  })

  it("lands the server's write stamp on a created row from its ack, with no meta until a /meta write", async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-stamp-create'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-stamp',
      updatedAt: '000000000001',
      data: { hello: 'world' }
    })
    // A fresh local row carries no server stamp.
    const fresh = await localRow(collection, 'cid-stamp')
    expect('updatedAtCounter' in fresh!).toBe(false)
    expect('originId' in fresh!).toBe(false)

    await eventually(async () =>
      committed(await observer.get({ id: 'cid-stamp' }))
    )
    // The ack writes back the stamp beside the validator, with no pull
    // nudged: the row holds the server's stamp once the write-back has landed.
    await eventually(
      async () => (await localRow(collection, 'cid-stamp'))?.etag !== undefined
    )
    await replication.awaitInSync()
    expect(
      holdsServerStamp(
        await localRow(collection, 'cid-stamp'),
        await observer.get({ id: 'cid-stamp' })
      )
    ).toBe(true)

    // The echo then changes nothing.
    replication.reSync()
    await replication.awaitInSync()
    const primary = await observer.get({ id: 'cid-stamp' })
    const local = await localRow(collection, 'cid-stamp')
    expect(local!.updatedAtCounter).toBeTypeOf('number')
    expect(local!.originId).toBeTypeOf('string')
    expect(local!.updatedAtCounter).toBe(primary!.updatedAtCounter)
    expect(local!.originId).toBe(primary!.originId)
    expect(local!.updatedAt).toBe(primary!.updatedAt)
    // No metadata was written, so neither the server nor the echo carries a
    // `/meta` stamp.
    expect('meta' in primary!).toBe(false)
    expect('meta' in local!).toBe(false)

    await replication.cancel()
  })

  it('lands the nested meta stamp from a /meta write, leaving the top-level updatedAt at the content stamp', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-stamp-meta'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-stamp-meta',
      updatedAt: '000000000001',
      data: { hello: 'world' }
    })
    await eventually(
      async () =>
        holdsServerStamp(
          await localRow(collection, 'cid-stamp-meta'),
          await observer.get({ id: 'cid-stamp-meta' })
        ),
      settledReSync(replication)
    )
    const content = await observer.get({ id: 'cid-stamp-meta' })
    expect('meta' in content!).toBe(false)

    // A metadata-only edit, with the app's own bumped `updatedAt`.
    const row = await collection.findOne('cid-stamp-meta').exec()
    await row!.incrementalPatch({
      custom: { name: 'Starred', tags: { starred: 'yes' } },
      updatedAt: '000000000002'
    })
    await eventually(
      async () =>
        (await observer.get({ id: 'cid-stamp-meta' }))?.meta !== undefined
    )
    const primary = await observer.get({ id: 'cid-stamp-meta' })
    await eventually(async () => {
      const local = await localRow(collection, 'cid-stamp-meta')
      return (
        holdsServerStamp(local, primary) &&
        JSON.stringify(local?.meta) === JSON.stringify(primary?.meta)
      )
    }, settledReSync(replication))
    const local = await localRow(collection, 'cid-stamp-meta')

    // The nested stamp lands whole, as the server reports it.
    expect(Object.keys(local!.meta!).sort()).toEqual([
      'generation',
      'originId',
      'updatedAt',
      'updatedAtCounter'
    ])
    expect(local!.meta).toEqual(primary!.meta)
    expect(local!.metaEtag).toBe(primary!.metaEtag)
    expect(local!.custom).toEqual({ name: 'Starred', tags: { starred: 'yes' } })

    // The `/meta` write touched no content: the server keeps the content
    // stamp and validator, and the echo replaces the app's bumped `updatedAt`
    // with the content stamp's.
    expect(primary!.updatedAt).toBe(content!.updatedAt)
    expect(primary!.updatedAtCounter).toBe(content!.updatedAtCounter)
    expect(primary!.originId).toBe(content!.originId)
    expect(primary!.etag).toBe(content!.etag)
    const echoed = (await observer.query({ limit: 100 })).documents.find(
      doc => doc.id === 'cid-stamp-meta'
    )
    expect(echoed?.updatedAt).toBe(content!.updatedAt)
    expect(echoed?.meta).toEqual(primary!.meta)
    expect(local!.updatedAt).toBe(content!.updatedAt)
    expect(local!.updatedAtCounter).toBe(content!.updatedAtCounter)
    expect(local!.originId).toBe(content!.originId)

    await replication.cancel()
  })

  it('pushes a custom edit made after the /meta ack and before its echo with If-Match, and no 412', async () => {
    // Between this replica's own `/meta` write and its echo the row holds
    // what the ack brought: `metaEtag`, and from a body-answering server the
    // `meta` stamp. The next metadata edit must route as an update on that
    // validator, not as a create the server would refuse.
    let conflicts = 0
    const collection = await openCollection({
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { metaWrites } = recordPreconditionsOn(port)
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-meta-pre-echo'
    })
    const errors: unknown[] = []
    replication.error$.subscribe(err => errors.push(err))
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-pre-echo',
      updatedAt: '000000000001',
      data: { hello: 'world' }
    })
    await eventually(
      async () =>
        holdsServerStamp(
          await localRow(collection, 'cid-pre-echo'),
          await observer.get({ id: 'cid-pre-echo' })
        ),
      settledReSync(replication)
    )
    const stamped = await localRow(collection, 'cid-pre-echo')
    expect('meta' in stamped!).toBe(false)
    expect('metaEtag' in stamped!).toBe(false)

    // The first `/meta` write. No pull is nudged from here on, so its echo
    // stays on the server.
    await (await collection.findOne('cid-pre-echo').exec())!.incrementalPatch({
      custom: { name: 'First', tags: {} },
      updatedAt: '000000000002'
    })
    await eventually(
      async () =>
        (await localRow(collection, 'cid-pre-echo'))?.metaEtag !== undefined
    )
    // Let the push cycle the write-back triggers settle, so RxDB records the
    // acked row as the assumed primary.
    await replication.awaitInSync()
    const acked = await localRow(collection, 'cid-pre-echo')
    const ackedPrimary = await observer.get({ id: 'cid-pre-echo' })
    expect(acked!.metaEtag).toBe(ackedPrimary?.metaEtag)
    expect(acked!.meta).toEqual(ackedPrimary?.meta)

    await (await collection.findOne('cid-pre-echo').exec())!.incrementalPatch({
      custom: { name: 'Second', tags: {} },
      updatedAt: '000000000003'
    })
    await eventually(
      async () =>
        JSON.stringify((await observer.get({ id: 'cid-pre-echo' }))?.custom) ===
        JSON.stringify({ name: 'Second', tags: {} })
    )
    await replication.awaitInSync()

    expect(metaWrites).toEqual([
      { ifNoneMatch: true },
      { ifMatch: acked!.metaEtag }
    ])
    expect(conflicts).toBe(0)
    expect(errors).toEqual([])

    await replication.cancel()
  })

  it('pushes a custom-metadata edit as a /meta write', async () => {
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-meta'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-meta',
      updatedAt: '000000000001',
      data: { hello: 'world' },
      // A plaintext collection's `custom` is the `{ name, tags }` shape, with
      // `tags` a string-to-string record.
      custom: { name: 'Starred', tags: { starred: 'yes' } }
    })
    await eventually(
      async () => (await observer.get({ id: 'cid-meta' }))?.custom !== undefined
    )

    const primary = await observer.get({ id: 'cid-meta' })
    expect(primary?.custom).toEqual({
      name: 'Starred',
      tags: { starred: 'yes' }
    })
    expect(primary?.data).toEqual({ hello: 'world' })

    await replication.cancel()
  })

  it('resolves a stale If-Match (412) by last write wins: a later local payload lands over the server', async () => {
    let conflicts = 0
    const collection = await openCollection({
      lww: true,
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { contentWrites } = recordPreconditionsOn(port)
    // The LWW payload (`updatedAt`, `writerId`) travels inside `data`.
    const created = await observer.putContent({
      id: 'cid-race',
      data: {
        step: 'server-1',
        updatedAt: '2026-01-01T00:00:01Z',
        writerId: 'b'
      }
    })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-412'
    })
    await replication.awaitInitialReplication()
    const pulled = await collection.findOne('cid-race').exec()
    expect(stepOf(pulled?.toJSON().data)).toBe('server-1')

    // Another writer bumps the resource behind the replica's back, so the
    // replica's next push carries a stale If-Match and the server answers 412.
    const bumped = await observer.putContent({
      id: 'cid-race',
      data: {
        step: 'server-2',
        updatedAt: '2026-01-01T00:00:02Z',
        writerId: 'b'
      },
      ifMatch: created.etag
    })
    await pulled!.incrementalPatch({
      data: {
        step: 'local-2',
        updatedAt: '2026-01-01T00:00:03Z',
        writerId: 'a'
      },
      updatedAt: '000000000003'
    })

    // The local payload is the later write, so it lands over the server's.
    await eventually(
      async () =>
        stepOf((await observer.get({ id: 'cid-race' }))?.data) === 'local-2',
      settledReSync(replication)
    )
    // The echo of the re-push lands, so nothing is left to push.
    await eventually(
      async () =>
        holdsServerStamp(
          await localRow(collection, 'cid-race'),
          await observer.get({ id: 'cid-race' })
        ),
      settledReSync(replication)
    )

    // The stale write was refused once, and the re-push carried the
    // validator the other writer's write earned.
    expect(contentWrites).toEqual([
      { ifMatch: created.etag },
      { ifMatch: bumped.etag }
    ])
    expect(conflicts).toBe(1)

    await replication.cancel()
  })

  it('resolves a stale If-Match (412) by last write wins: a later remote payload replaces the local edit', async () => {
    let conflicts = 0
    const collection = await openCollection({
      lww: true,
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { contentWrites } = recordPreconditionsOn(port)
    const created = await observer.putContent({
      id: 'cid-race-remote',
      data: {
        step: 'server-1',
        updatedAt: '2026-01-01T00:00:01Z',
        writerId: 'b'
      }
    })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-412-remote'
    })
    await replication.awaitInitialReplication()
    const pulled = await collection.findOne('cid-race-remote').exec()
    expect(stepOf(pulled?.toJSON().data)).toBe('server-1')

    // This time the other writer's write carries the later payload.
    const bumped = await observer.putContent({
      id: 'cid-race-remote',
      data: {
        step: 'server-2',
        updatedAt: '2026-01-01T00:00:03Z',
        writerId: 'b'
      },
      ifMatch: created.etag
    })
    await pulled!.incrementalPatch({
      data: {
        step: 'local-2',
        updatedAt: '2026-01-01T00:00:02Z',
        writerId: 'a'
      },
      updatedAt: '000000000002'
    })

    // The local edit loses: the replica takes the server's state.
    await eventually(
      async () => {
        const current = await collection.findOne('cid-race-remote').exec()
        return (
          stepOf(current?.toJSON().data) === 'server-2' &&
          current?.toJSON().etag === bumped.etag
        )
      },
      () => replication.reSync()
    )

    // One refused write and no re-push; the server still holds its state.
    expect(contentWrites).toEqual([{ ifMatch: created.etag }])
    expect(conflicts).toBe(1)
    const primary = await observer.get({ id: 'cid-race-remote' })
    expect(stepOf(primary?.data)).toBe('server-2')
    expect(primary?.etag).toBe(bumped.etag)

    await replication.cancel()
  })

  it('resolves a validator-only 412 to the local edit and re-pushes it against the fresh etag', async () => {
    // Another writer re-writes the body this replica last synced, unchanged,
    // so the server's `etag` and stamp move while its content does not. The
    // local edit's `If-Match` is then stale, but the conflict is about the
    // validator alone: rule 1 keeps the local edit. Its payload is older than
    // the server's, so payload last-write-wins alone would have kept the
    // server's body, and the local edit landing proves rule 1 decided.
    let conflicts = 0
    const collection = await openCollection({
      lww: true,
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { contentWrites } = recordPreconditionsOn(port)
    const body = {
      step: 'server-1',
      updatedAt: '2026-01-01T00:00:05Z',
      writerId: 'b'
    }
    const created = await observer.putContent({
      id: 'cid-validator',
      data: body
    })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-412-validator'
    })
    const errors: unknown[] = []
    replication.error$.subscribe(err => errors.push(err))
    await replication.awaitInitialReplication()
    const pulled = await collection.findOne('cid-validator').exec()
    expect(pulled?.toJSON().etag).toBe(created.etag)

    const rewritten = await observer.putContent({
      id: 'cid-validator',
      data: body,
      ifMatch: created.etag
    })
    expect(rewritten.etag).toBeDefined()
    expect(rewritten.etag).not.toBe(created.etag)
    await pulled!.incrementalPatch({
      data: {
        step: 'local-2',
        updatedAt: '2026-01-01T00:00:02Z',
        writerId: 'a'
      },
      updatedAt: '000000000002'
    })

    await eventually(
      async () =>
        stepOf((await observer.get({ id: 'cid-validator' }))?.data) ===
        'local-2',
      settledReSync(replication)
    )
    await eventually(
      async () =>
        holdsServerStamp(
          await localRow(collection, 'cid-validator'),
          await observer.get({ id: 'cid-validator' })
        ),
      settledReSync(replication)
    )

    // One refused write on the pulled validator, then one re-push on the
    // validator the re-write earned.
    expect(contentWrites).toEqual([
      { ifMatch: created.etag },
      { ifMatch: rewritten.etag }
    ])
    expect(conflicts).toBe(1)
    expect(errors).toEqual([])
    const local = await localRow(collection, 'cid-validator')
    expect(stepOf(local?.data)).toBe('local-2')
    expect(local?.etag).toBe(
      (await observer.get({ id: 'cid-validator' }))?.etag
    )

    await replication.cancel()
  })

  it('resurrects a resource another replica deleted, on the plain port, in one cycle', async () => {
    // Replica B deletes X behind this replica's back; this replica edits X.
    // The push 412s, the plain port's re-read is null (a tombstone GET is a
    // 404), the conflict entry is a tombstone, and the local edit wins. The
    // re-push must then be a create (`If-None-Match: *`), which the server
    // accepts against a tombstone, rather than an `If-Match` it always refuses
    // or an unconditional overwrite.
    const collection = await openCollection({ lww: true })
    const { port, observer } = await openServerCollection()
    const { contentWrites } = recordPreconditionsOn(port)
    const created = await observer.putContent({
      id: 'cid-resurrect',
      data: {
        step: 'server-1',
        updatedAt: '2026-01-01T00:00:01Z',
        writerId: 'b'
      }
    })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-resurrect'
    })
    const errors: unknown[] = []
    replication.error$.subscribe(err => errors.push(err))
    await replication.awaitInitialReplication()
    const pulled = await collection.findOne('cid-resurrect').exec()
    expect(stepOf(pulled?.toJSON().data)).toBe('server-1')

    await observer.deleteContent({ id: 'cid-resurrect', ifMatch: created.etag })
    expect(await observer.get({ id: 'cid-resurrect' })).toBeNull()
    await pulled!.incrementalPatch({
      data: {
        step: 'local-2',
        updatedAt: '2026-01-01T00:00:03Z',
        writerId: 'a'
      },
      updatedAt: '000000000003'
    })

    await eventually(
      async () =>
        stepOf((await observer.get({ id: 'cid-resurrect' }))?.data) ===
        'local-2',
      () => replication.reSync()
    )
    await eventually(
      async () => {
        const current = await collection.findOne('cid-resurrect').exec()
        const primary = await observer.get({ id: 'cid-resurrect' })
        return current?.toJSON().etag === primary?.etag
      },
      () => replication.reSync()
    )

    // One refused update, then exactly one create; no `If-Match` re-issue.
    expect(contentWrites).toEqual([
      { ifMatch: created.etag },
      { ifNoneMatch: true }
    ])
    expect(errors).toEqual([])

    await replication.cancel()
  })

  it('resurrects a row carrying custom: the /meta half is a create', async () => {
    // The tombstone drops the metadata object together with `custom`, so the
    // push handler's `/meta` write on a resurrection goes out as a
    // create-if-absent (`If-None-Match: *`) and lands in the same push cycle
    // as the content create.
    let conflicts = 0
    const collection = await openCollection({
      lww: true,
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { contentWrites, metaWrites } = recordPreconditionsOn(port)
    const created = await observer.putContent({
      id: 'cid-resurrect-meta',
      data: {
        step: 'server-1',
        updatedAt: '2026-01-01T00:00:01Z',
        writerId: 'b'
      }
    })
    const createdMeta = await observer.putMeta({
      id: 'cid-resurrect-meta',
      custom: { name: 'Before', tags: {} },
      ifNoneMatch: true
    })
    const preDeleteMetaEtag = createdMeta?.etag
    expect(preDeleteMetaEtag).toBeDefined()

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-resurrect-meta'
    })
    const errors: unknown[] = []
    replication.error$.subscribe(err => errors.push(err))
    await replication.awaitInitialReplication()
    const pulled = await collection.findOne('cid-resurrect-meta').exec()
    expect(pulled?.toJSON().custom).toEqual({ name: 'Before', tags: {} })
    expect(pulled?.toJSON().metaEtag).toBe(preDeleteMetaEtag)

    await observer.deleteContent({
      id: 'cid-resurrect-meta',
      ifMatch: created.etag
    })
    expect(await observer.get({ id: 'cid-resurrect-meta' })).toBeNull()
    await pulled!.incrementalPatch({
      data: {
        step: 'local-2',
        updatedAt: '2026-01-01T00:00:03Z',
        writerId: 'a'
      },
      custom: { name: 'After', tags: { starred: 'yes' } },
      updatedAt: '000000000003'
    })

    await eventually(async () => {
      const primary = await observer.get({ id: 'cid-resurrect-meta' })
      return (
        stepOf(primary?.data) === 'local-2' && primary?.custom !== undefined
      )
    })
    await eventually(
      async () => {
        const current = await collection.findOne('cid-resurrect-meta').exec()
        const primary = await observer.get({ id: 'cid-resurrect-meta' })
        return (
          current?.toJSON().etag === primary?.etag &&
          current?.toJSON().metaEtag === primary?.metaEtag
        )
      },
      () => replication.reSync()
    )

    // The content half: one refused update, then one create. The metadata
    // half: exactly one write, a create-if-absent, accepted first time. The
    // only conflict resolved is the content 412 against the tombstone; the
    // `/meta` write raised none.
    expect(contentWrites).toEqual([
      { ifMatch: created.etag },
      { ifNoneMatch: true }
    ])
    expect(metaWrites).toEqual([{ ifNoneMatch: true }])
    expect(conflicts).toBe(1)
    expect(errors).toEqual([])
    const primary = await observer.get({ id: 'cid-resurrect-meta' })
    expect(primary?.custom).toEqual({ name: 'After', tags: { starred: 'yes' } })

    await replication.cancel()
  })

  it('resurrects a row over a feed tombstone, sending the /meta half as If-None-Match: *', async () => {
    // Another writer deletes a row carrying metadata and the tombstone rides
    // the feed down, so the replica's assumed primary is that tombstone. A
    // re-insert of the id is then a create on both halves: a tombstone holds
    // no live `/meta` record to condition on.
    let conflicts = 0
    const collection = await openCollection({
      lww: true,
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { contentWrites, metaWrites } = recordPreconditionsOn(port)
    const created = await observer.putContent({
      id: 'cid-feed-tomb',
      data: { step: 'server-1' }
    })
    await observer.putMeta({
      id: 'cid-feed-tomb',
      custom: { name: 'Before', tags: {} },
      ifNoneMatch: true
    })

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-feed-tombstone'
    })
    const errors: unknown[] = []
    replication.error$.subscribe(err => errors.push(err))
    await replication.awaitInitialReplication()
    const pulled = await localRow(collection, 'cid-feed-tomb')
    expect(pulled?.meta).toBeDefined()
    expect(pulled?.metaEtag).toBeDefined()

    await observer.deleteContent({ id: 'cid-feed-tomb', ifMatch: created.etag })
    await eventually(
      async () => (await collection.findOne('cid-feed-tomb').exec()) === null,
      settledReSync(replication)
    )
    // The server's tombstone carries no `/meta` stamp or validator.
    const tombstone = (await observer.query({ limit: 100 })).documents.find(
      doc => doc.id === 'cid-feed-tomb'
    )
    expect(tombstone?._deleted).toBe(true)
    expect('meta' in tombstone!).toBe(false)
    expect('metaEtag' in tombstone!).toBe(false)

    await collection.insert({
      id: 'cid-feed-tomb',
      updatedAt: '000000000003',
      data: { step: 'local-2' },
      custom: { name: 'After', tags: { starred: 'yes' } }
    })
    await eventually(async () => {
      const primary = await observer.get({ id: 'cid-feed-tomb' })
      return (
        stepOf(primary?.data) === 'local-2' &&
        JSON.stringify(primary?.custom) ===
          JSON.stringify({ name: 'After', tags: { starred: 'yes' } })
      )
    })
    await replication.awaitInSync()

    expect(contentWrites).toEqual([{ ifNoneMatch: true }])
    expect(metaWrites).toEqual([{ ifNoneMatch: true }])
    expect(conflicts).toBe(0)
    expect(errors).toEqual([])

    await replication.cancel()
  })

  it('recovers a metadata-only edit against a resource another replica deleted (default port)', async () => {
    // Replica B deletes X; this replica, offline, edits only X's metadata. On
    // reconnect no content write runs (the body is unchanged), so the `/meta`
    // `If-Match` is the first write to meet the tombstone and the server
    // answers 404. The default port raises that as the not-found signal; the
    // push handler corroborates it off the feed, resolves the row as a
    // tombstone conflict, and the live local edit wins: the next cycle
    // re-creates the content and the metadata. The batch never rejects.
    let conflicts = 0
    const collection = await openCollection({
      lww: true,
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { contentWrites, metaWrites } = recordPreconditionsOn(port)
    const created = await observer.putContent({
      id: 'cid-meta-race',
      data: {
        step: 'server-1',
        updatedAt: '2026-01-01T00:00:01Z',
        writerId: 'b'
      }
    })
    const createdMeta = await observer.putMeta({
      id: 'cid-meta-race',
      custom: { name: 'Before', tags: {} },
      ifNoneMatch: true
    })
    const preDeleteMetaEtag = createdMeta?.etag
    expect(preDeleteMetaEtag).toBeDefined()

    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-meta-race'
    })
    const errors: unknown[] = []
    replication.error$.subscribe(err => errors.push(err))
    await replication.awaitInitialReplication()
    const pulled = await collection.findOne('cid-meta-race').exec()
    expect(pulled?.toJSON().metaEtag).toBe(preDeleteMetaEtag)

    await observer.deleteContent({ id: 'cid-meta-race', ifMatch: created.etag })
    expect(await observer.get({ id: 'cid-meta-race' })).toBeNull()
    await pulled!.incrementalPatch({
      custom: { name: 'After', tags: { starred: 'yes' } },
      updatedAt: '000000000003'
    })

    await eventually(
      async () => {
        const current = await collection.findOne('cid-meta-race').exec()
        const primary = await observer.get({ id: 'cid-meta-race' })
        return (
          current?.toJSON().etag === primary?.etag &&
          current?.toJSON().metaEtag === primary?.metaEtag
        )
      },
      () => replication.reSync()
    )

    // The metadata half: the refused `If-Match` against the tombstone, then a
    // create-if-absent. The content half: no write until the tombstone
    // conflict resolved, then exactly one create. One conflict, no error.
    expect(metaWrites).toEqual([
      { ifMatch: preDeleteMetaEtag },
      { ifNoneMatch: true }
    ])
    expect(contentWrites).toEqual([{ ifNoneMatch: true }])
    expect(conflicts).toBe(1)
    expect(errors).toEqual([])
    const primary = await observer.get({ id: 'cid-meta-race' })
    expect(stepOf(primary?.data)).toBe('server-1')
    expect(primary?.custom).toEqual({ name: 'After', tags: { starred: 'yes' } })

    await replication.cancel()
  })

  it('surfaces a delete of a resource another writer re-created as a conflict, not a tombstone', async () => {
    // Replica A pushes a row under its own label, then another writer deletes
    // and re-creates the same id with the same body. A's delete carries A's
    // last-known validator and 412s; the re-read body is equal, so only the
    // writer label says this is not A's own validator drift. Remote wins, so A
    // ends up holding the re-created row and the server's copy stays live.
    let conflicts = 0
    const collection = await openCollection({
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { deleteWrites } = recordPreconditionsOn(port)
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-recreate',
      writerId: 'writer-a'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-recreated',
      updatedAt: '000000000001',
      data: { fixed: true }
    })
    await eventually(
      async () =>
        committed(await observer.get({ id: 'cid-recreated' })) &&
        (await collection.findOne('cid-recreated').exec())?.get('etag') !==
          undefined
    )
    // The write-back's own push cycle settles, so RxDB holds the acked row as
    // the assumed primary and the delete conditions on its `etag`.
    await replication.awaitInSync()

    const own = await observer.get({ id: 'cid-recreated' })
    await observer.deleteContent({
      id: 'cid-recreated',
      ifMatch: own!.etag,
      writerId: 'writer-b'
    })
    const recreated = await observer.putContent({
      id: 'cid-recreated',
      data: { fixed: true },
      ifNoneMatch: true,
      writerId: 'writer-b'
    })
    // No integer orders the two records; the validators tell them apart.
    expect(recreated.etag).toBeDefined()
    expect(recreated.etag).not.toBe(own!.etag)

    await (await collection.findOne('cid-recreated').exec())!.remove()
    // The delete is refused and resolved rather than re-issued: the local row
    // comes back live on the re-created record.
    await eventually(
      async () => {
        const current = await collection.findOne('cid-recreated').exec()
        return current !== null && current.get('etag') === recreated.etag
      },
      () => replication.reSync()
    )

    // Exactly one conditional delete, on A's own validator, and the refusal
    // reached the conflict handler rather than being read as done.
    expect(deleteWrites).toEqual([{ ifMatch: own!.etag }])
    expect(conflicts).toBe(1)
    const primary = await observer.get({ id: 'cid-recreated' })
    expect(primary).not.toBeNull()
    expect(primary!.etag).toBe(recreated.etag)
    expect(primary!.writerId).toBe('writer-b')
    // The conflict entry carried the re-created record's stamp into the row.
    const local = await localRow(collection, 'cid-recreated')
    expect(local!.updatedAtCounter).toBe(primary!.updatedAtCounter)
    expect(local!.originId).toBe(primary!.originId)
    expect(local!.updatedAt).toBe(primary!.updatedAt)

    await replication.cancel()
  })

  it('runs on the validator alone over a port that hides the write stamp', async () => {
    // A primary read may come back with no write stamp and no `meta` (a
    // deployment that hides them, or a `/meta` read that is not whole), so
    // the driver must route every write on the `etag` alone. The wrapper
    // below strips `updatedAtCounter`, `originId`, and `meta` off every
    // primary read and withholds the feed, so the row can learn state only
    // from an ack write-back or a conflict entry, and never a stamp. Two
    // edits then go out with no 412, and a write raced by another writer
    // resolves on a conflict entry that carries no stamp, whose `etag` the
    // next write still conditions on.
    const { port: real, observer } = await openServerCollection()
    let conflicts = 0
    const contentWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }> = []
    const hiddenStamp: WasSyncPort = {
      async query() {
        return { documents: [], checkpoint: null }
      },
      async get(options) {
        const primary = await real.get(options)
        if (primary === null) {
          return null
        }
        const {
          updatedAtCounter: _counter,
          originId: _origin,
          meta: _meta,
          ...rest
        } = primary
        return rest
      },
      async putContent(options) {
        contentWrites.push({
          ...(options.ifMatch !== undefined && { ifMatch: options.ifMatch }),
          ...(options.ifNoneMatch !== undefined && {
            ifNoneMatch: options.ifNoneMatch
          })
        })
        try {
          return await real.putContent(options)
        } catch (err) {
          if (isSyncConflictError(err)) {
            conflicts += 1
          }
          throw err
        }
      },
      async putMeta(options) {
        return real.putMeta(options)
      },
      async deleteContent(options) {
        return real.deleteContent(options)
      }
    }
    const conflictInputs: ConflictInput[] = []
    const collection = await openCollection({
      onConflict: input => conflictInputs.push(input)
    })
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: hiddenStamp,
      replicationIdentifier: 'test-hidden-stamp'
    })
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-opaque',
      updatedAt: '000000000001',
      data: { step: 'local-1' }
    })
    await eventually(async () =>
      committed(await observer.get({ id: 'cid-opaque' }))
    )

    for (const step of ['local-2', 'local-3']) {
      // The acked validator reaches the row with no feed to carry it, and
      // its push cycle settles before the next edit.
      await eventually(async () => {
        const primary = await observer.get({ id: 'cid-opaque' })
        const current = await localRow(collection, 'cid-opaque')
        return current?.etag === primary?.etag
      })
      await replication.awaitInSync()
      const row = await collection.findOne('cid-opaque').exec()
      await row!.incrementalPatch({
        data: { step },
        updatedAt: step === 'local-2' ? '000000000002' : '000000000003'
      })
      await eventually(
        async () =>
          stepOf((await observer.get({ id: 'cid-opaque' }))?.data) === step
      )
    }
    expect(conflicts).toBe(0)
    await eventually(async () => {
      const primary = await observer.get({ id: 'cid-opaque' })
      const current = await localRow(collection, 'cid-opaque')
      return current?.etag === primary?.etag
    })
    await replication.awaitInSync()

    // Another writer moves the resource behind the replica's back, so the
    // next local edit is refused and its conflict entry comes off the
    // stamp-hiding read. The remote state wins.
    const beforeBump = (await observer.get({ id: 'cid-opaque' }))!.etag
    const bumped = await observer.putContent({
      id: 'cid-opaque',
      data: { step: 'server-4' },
      ifMatch: beforeBump
    })
    await (await collection.findOne('cid-opaque').exec())!.incrementalPatch({
      data: { step: 'local-5' },
      updatedAt: '000000000005'
    })
    await eventually(async () => {
      const current = await localRow(collection, 'cid-opaque')
      return (
        stepOf(current?.data) === 'server-4' && current?.etag === bumped.etag
      )
    })
    expect(conflicts).toBe(1)
    expect(conflictInputs).toHaveLength(1)
    const { realMasterState } = conflictInputs[0]!
    expect(realMasterState.etag).toBe(bumped.etag)
    expect('updatedAtCounter' in realMasterState).toBe(false)
    expect('originId' in realMasterState).toBe(false)
    expect('meta' in realMasterState).toBe(false)
    const resolved = await localRow(collection, 'cid-opaque')
    expect('updatedAtCounter' in resolved!).toBe(false)
    expect('originId' in resolved!).toBe(false)
    await replication.awaitInSync()

    // The next edit conditions on the conflict entry's `etag` and lands.
    await (await collection.findOne('cid-opaque').exec())!.incrementalPatch({
      data: { step: 'local-6' },
      updatedAt: '000000000006'
    })
    await eventually(
      async () =>
        stepOf((await observer.get({ id: 'cid-opaque' }))?.data) === 'local-6'
    )
    expect(contentWrites.slice(-2)).toEqual([
      { ifMatch: beforeBump },
      { ifMatch: bumped.etag }
    ])
    expect(conflicts).toBe(1)

    await replication.cancel()
  })

  it('declares the injected writerId on every push, and a fresh replica under the same label pulls the mixed feed', async () => {
    const { port, observer } = await openServerCollection()
    // A foreign-labeled write, an unlabeled one, and a tombstone, all
    // written by another writer.
    await observer.putContent({
      id: 'cid-foreign',
      data: { from: 'foreign' },
      writerId: 'writer-b'
    })
    await observer.putContent({ id: 'cid-unlabeled', data: { from: 'none' } })
    const doomed = await observer.putContent({
      id: 'cid-gone',
      data: { from: 'doomed' },
      writerId: 'writer-b'
    })
    await observer.deleteContent({
      id: 'cid-gone',
      ifMatch: doomed.etag,
      writerId: 'writer-b'
    })

    // Replica A writes under its own label and replicates its own echo back.
    const declared: Array<{ kind: string; writerId?: string }> = []
    const rawPut = port.putContent.bind(port)
    port.putContent = async options => {
      declared.push({ kind: 'putContent', writerId: options.writerId })
      return rawPut(options)
    }
    const rawPutMeta = port.putMeta.bind(port)
    port.putMeta = async options => {
      // A `/meta` write sends no label: the label is a member of the content
      // record alone.
      expect(options).not.toHaveProperty('writerId')
      declared.push({ kind: 'putMeta' })
      return rawPutMeta(options)
    }
    const rawDelete = port.deleteContent.bind(port)
    port.deleteContent = async options => {
      declared.push({ kind: 'deleteContent', writerId: options.writerId })
      return rawDelete(options)
    }
    const replicaA = await openCollection()
    const replicationA = createWasReplication({
      rxCollection: replicaA,
      wasPort: port,
      replicationIdentifier: 'test-writer-a',
      writerId: 'writer-a'
    })
    await replicationA.awaitInitialReplication()
    await replicaA.insert({
      id: 'cid-own',
      updatedAt: '000000000001',
      data: { from: 'own' },
      custom: { name: 'mine' }
    })
    await replicaA.insert({
      id: 'cid-own-gone',
      updatedAt: '000000000001',
      data: { from: 'own-doomed' }
    })
    // The pushes alone bring the server up to date.
    await eventually(
      async () =>
        committed(await observer.get({ id: 'cid-own' })) &&
        committed(await observer.get({ id: 'cid-own-gone' }))
    )
    // Wait for the ack write-back before deleting, so the delete carries the
    // server's validator.
    await eventually(
      async () =>
        (await replicaA.findOne('cid-own-gone').exec())?.get('etag') !==
        undefined
    )
    await (await replicaA.findOne('cid-own-gone').exec())?.remove()
    await eventually(
      async () => (await observer.get({ id: 'cid-own-gone' })) === null
    )
    // A's own echoes come back down the feed; the ack already stamped what
    // they carry, so the nudge needs no wait for the pushes to settle.
    replicationA.reSync()
    await replicationA.awaitInSync()
    await replicationA.cancel()
    const replicaAState = (await replicaA.find().exec())
      .map(doc => doc.toJSON())
      .sort((left, right) => left.id.localeCompare(right.id))

    expect(declared.map(write => write.kind).sort()).toEqual([
      'deleteContent',
      'putContent',
      'putContent',
      'putMeta'
    ])
    // The label rides the content writes and the delete; the `putMeta` spy
    // above checks that the `/meta` write carried none.
    for (const write of declared.filter(write => write.kind !== 'putMeta')) {
      expect(write.writerId).toBe('writer-a')
    }

    // A fresh replica under A's label (which holds none of those writes)
    // pulls the same feed.
    const withLabel = await pullFreshReplica({
      replicationIdentifier: 'test-writer-writer-a',
      writerId: 'writer-a'
    })

    expect(withLabel.map(doc => doc.id)).toEqual([
      'cid-foreign',
      'cid-own',
      'cid-unlabeled'
    ])
    // The writer's own replica agrees with a fresh one on every member of
    // every row it replicated, the server-assigned `createdBy` and `updatedAt`
    // of its own rows included: their feed echo landed over the ack write-back.
    expect(replicaAState).toEqual(withLabel)
    for (const doc of withLabel) {
      expect('writerId' in doc).toBe(false)
    }
  })

  it('holds the server state from the ack when the echo is pulled into the write-back window and dropped', async () => {
    // The forced window. RxDB admits a nudged pull only once the running push
    // has finished, so the pull lands in the gap the ack write-back opens: the
    // row has been patched locally and the push cycle that records the patch
    // as the assumed primary has not completed. To hold that cycle open, the
    // row is edited during the first push, so the second push carries a real
    // content write whose response the test holds. The pull returns the echo
    // while the second push is in flight, RxDB drops it behind the pending
    // local write and moves the checkpoint past it, and the ack of the held
    // write is the only source left for what the server assigned.
    const collection = await openCollection()
    const { port, observer } = await openServerCollection()
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let contentWrites = 0
    const rawPut = port.putContent.bind(port)
    port.putContent = async options => {
      contentWrites += 1
      const write = contentWrites
      const ack = await rawPut(options)
      if (write === 1) {
        // Edit the row while its first push is in flight, and queue the pull
        // so it fires the moment this push finishes.
        await (await collection.findOne(options.id).exec())!.incrementalPatch({
          data: { hello: 'again' },
          updatedAt: '000000000002'
        })
        replication.reSync()
      } else {
        await held
      }
      return ack
    }
    const echoed: string[] = []
    const rawQuery = port.query.bind(port)
    port.query = async options => {
      const page = await rawQuery(options)
      echoed.push(...page.documents.map(document => document.id))
      return page
    }
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-forced-window'
    })
    const errors: unknown[] = []
    replication.error$.subscribe(err => errors.push(err))
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-window',
      updatedAt: '000000000001',
      data: { hello: 'world' }
    })
    // The pull handler returns the echo while the second write is held.
    await eventually(async () => echoed.includes('cid-window'))
    expect(contentWrites).toBe(2)
    // Give the downstream its turn with the batch, then check the drop: the
    // row still holds the edit's own `updatedAt` and no server stamp. (The
    // first ack already stamped `createdBy`; its stamp was for the superseded
    // state and was skipped, so the stamp is what only the echo could have
    // brought here.)
    await new Promise(resolve => setTimeout(resolve, 150))
    const dropped = await localRow(collection, 'cid-window')
    expect(dropped?.updatedAt).toBe('000000000002')
    expect('updatedAtCounter' in dropped!).toBe(false)
    expect('originId' in dropped!).toBe(false)

    release()
    await replication.awaitInSync()
    // No further pull: what the row holds now came from the acks alone.
    const primary = await observer.get({ id: 'cid-window' })
    const local = await localRow(collection, 'cid-window')
    expect(local?.data).toEqual({ hello: 'again' })
    expect(local?.createdBy).toBe(controllerDid)
    expect(local?.updatedAt).toBe(primary?.updatedAt)
    expect(local?.updatedAtCounter).toBe(primary?.updatedAtCounter)
    expect(local?.originId).toBe(primary?.originId)
    expect(local?.etag).toBe(primary?.etag)
    expect(errors).toEqual([])

    await replication.cancel()
  })

  it("lands the resolver's choice when another replica deletes between the content write and the /meta write", async () => {
    // A create carrying `custom` is two writes. Another replica deletes the
    // resource after the content write lands and before the `/meta` write, so
    // the `/meta` write 404s, the re-read corroborates the tombstone, and the
    // row is handed to the resolver with the tombstone as the conflict entry.
    // The default resolver takes the remote side: the local row is deleted
    // and no second content write re-creates the resource over the tombstone.
    let conflicts = 0
    const collection = await openCollection({
      onConflict: () => (conflicts += 1)
    })
    const { port, observer } = await openServerCollection()
    const { contentWrites, metaWrites } = recordPreconditionsOn(port)
    const rawPut = port.putContent.bind(port)
    port.putContent = async options => {
      const ack = await rawPut(options)
      await observer.deleteContent({ id: options.id, ifMatch: ack.etag })
      return ack
    }
    const replication = createWasReplication({
      rxCollection: collection,
      wasPort: port,
      replicationIdentifier: 'test-meta-tombstone-race'
    })
    const errors: unknown[] = []
    replication.error$.subscribe(err => errors.push(err))
    await replication.awaitInitialReplication()

    await collection.insert({
      id: 'cid-meta-race',
      updatedAt: '000000000001',
      data: { hello: 'world' },
      custom: { name: 'Mine', tags: {} }
    })
    await eventually(
      async () => (await localRow(collection, 'cid-meta-race')) === null
    )
    await replication.awaitInSync()
    await replication.cancel()

    expect(conflicts).toBe(1)
    expect(contentWrites).toEqual([{ ifNoneMatch: true }])
    expect(metaWrites).toEqual([{ ifNoneMatch: true }])
    expect(await observer.get({ id: 'cid-meta-race' })).toBeNull()
    expect(errors).toEqual([])
  })
})
