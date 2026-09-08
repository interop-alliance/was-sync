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
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRxDatabase, type RxDatabase } from 'rxdb/plugins/core'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { createApp, FileSystemBackend } from 'was-teaching-server'
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
import { lwwResolver, makeConflictHandler } from '../../src/conflictHandler.js'
import type { Json, WasSyncPort } from '../../src/types.js'

// A fixed 32-byte seed so the controller DID, and therefore the Space id, is
// stable across runs; the data directory is fresh each run regardless.
const SEED = new Uint8Array(32).map((_, index) => (index * 31 + 7) & 0xff)

let dataDir: string
let app: ReturnType<typeof createApp>
let was: WasClient
let spaceId: string
let controllerDid: string
let db: RxDatabase | undefined
let collectionSerial = 0

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'was-sync-integration-'))
  // The port is not known until `listen()` resolves, so the app boots against
  // a placeholder base URL and `serverUrl` is corrected before the first
  // request; zcap invocation targets embed it, so it must match exactly.
  app = createApp({
    serverUrl: 'http://localhost',
    logger: false,
    backend: new FileSystemBackend({ dataDir, capacityBytes: Infinity })
  })
  await app.listen({ port: 0 })
  const serverUrl = `http://localhost:${(app.server.address() as AddressInfo).port}`
  app.serverUrl = serverUrl

  const keyPair = await Ed25519VerificationKey.generate({ seed: SEED })
  controllerDid = `did:key:${keyPair.fingerprint()}`
  keyPair.id = `${controllerDid}#${keyPair.fingerprint()}`
  was = WasClient.fromSigner({ serverUrl, signer: keyPair.signer() })
  spaceId = deriveSpaceId(controllerDid)
})

afterAll(async () => {
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
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
  const build = () =>
    createWasSyncPort({ was, spaceId, collectionId }) as WasSyncPort
  return { port: build(), observer: build() }
}

/**
 * Opens a fresh memory-storage collection on the synced-document schema. With
 * `lww` set, the package's last-write-wins conflict handler is installed over
 * plaintext bodies; otherwise RxDB's default (remote wins) applies.
 */
async function openCollection({
  lww = false,
  onConflict
}: { lww?: boolean; onConflict?: () => void } = {}) {
  db = await createRxDatabase({
    name: 'synctest' + Math.floor(performance.now()).toString(36),
    storage: getRxStorageMemory(),
    multiInstance: false
  })
  const resolve = lwwResolver({ decrypt: async envelope => envelope })
  const { synced } = await db.addCollections({
    synced: {
      schema: syncedDocSchema(),
      ...(lww && {
        conflictHandler: makeConflictHandler({
          resolve: async input => {
            onConflict?.()
            return resolve(input)
          }
        })
      })
    }
  })
  return synced
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
 * Wraps the port's two writes to record the precondition each one carried, so
 * a test can assert the exact conditional-write sequence the driver issued.
 */
function recordPreconditionsOn(port: WasSyncPort): {
  contentWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }>
  metaWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }>
} {
  const contentWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }> = []
  const metaWrites: Array<{ ifMatch?: string; ifNoneMatch?: boolean }> = []
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
  return { contentWrites, metaWrites }
}

/**
 * Waits until `predicate` holds, nudging replication and polling. Avoids
 * depending on exact RxDB cycle timing.
 */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  nudge?: () => void
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) {
      return
    }
    nudge?.()
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
      version: 0,
      data: { hello: 'world' }
    })

    await eventually(async () => (await observer.get({ id: 'cid-1' })) !== null)
    const primary = await observer.get({ id: 'cid-1' })
    expect(primary?.data).toEqual({ hello: 'world' })
    expect(primary?.version).toBeGreaterThanOrEqual(1)

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

  it('round-trips the key-epoch id: a local epoch-stamped doc pushes and pulls back with it intact', async () => {
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
      version: 0,
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

    await replication.cancel()
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
      version: 0,
      data: { x: 1 }
    })
    // Wait for the create to fully round-trip: pushed to the server AND the
    // server `version` echoed back locally, so the delete's `If-Match` is not
    // stale (the create-then-immediate-delete race of tension 1).
    await eventually(
      async () => {
        const current = await collection.findOne('cid-del').exec()
        return (
          (await observer.get({ id: 'cid-del' })) !== null &&
          (current?.toJSON().version ?? 0) >= 1
        )
      },
      () => replication.reSync()
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
      version: 0,
      data: { x: 1 }
    })
    await eventually(
      async () => (await observer.get({ id: 'cid-shared' })) !== null,
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
    }) as WasSyncPort
    const deletes: string[] = []
    const rawDelete = portB.deleteContent.bind(portB)
    portB.deleteContent = async options => {
      deletes.push(options.id)
      return rawDelete(options)
    }
    await replicaB.insert({
      id: 'cid-shared',
      updatedAt: '000000000001',
      version: 0,
      data: { x: 1 }
    })
    await (await replicaB.findOne('cid-shared').exec())!.remove()
    await replicaB.insert({
      id: 'cid-sibling',
      updatedAt: '000000000002',
      version: 0,
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
    // A's copy is intact, under the revision A's create earned.
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
      version: 0,
      data: { hello: 'world' }
    })
    await eventually(
      async () => (await observer.get({ id: 'cid-author' })) !== null
    )

    const primary = await observer.get({ id: 'cid-author' })
    expect(primary?.createdBy).toBe(controllerDid)

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
      version: 0,
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

  it('resolves a stale If-Match (412) by last write wins and converges', async () => {
    const collection = await openCollection({ lww: true })
    const { port, observer } = await openServerCollection()
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
    await observer.putContent({
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
      () => replication.reSync()
    )
    await eventually(
      async () => {
        const current = await collection.findOne('cid-race').exec()
        const primary = await observer.get({ id: 'cid-race' })
        return current?.toJSON().version === primary?.version
      },
      () => replication.reSync()
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

  it('resurrects a row carrying custom: the /meta half is a create, and the pre-delete meta ETag is dead', async () => {
    // The tombstone drops the metadata object together with `custom`, so the
    // push handler's `/meta` write on a resurrection goes out as a
    // create-if-absent (`If-None-Match: *`) and lands in the same push cycle
    // as the content create. The server also retires the pre-delete metadata
    // validator with the tombstone: its generation dies with the metadata
    // object, so a stale replica's `If-Match` cannot clobber the resurrected
    // row's `custom`.
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
    expect(primary?.metaEtag).not.toBe(preDeleteMetaEtag)

    // A replica still holding the pre-delete metadata validator is refused:
    // its `If-Match` is a 412, not a clobber.
    await expect(
      observer.putMeta({
        id: 'cid-resurrect-meta',
        custom: { name: 'Stale', tags: {} },
        ifMatch: preDeleteMetaEtag
      })
    ).rejects.toSatisfy(isSyncConflictError)
    expect((await observer.get({ id: 'cid-resurrect-meta' }))?.custom).toEqual({
      name: 'After',
      tags: { starred: 'yes' }
    })

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
})
