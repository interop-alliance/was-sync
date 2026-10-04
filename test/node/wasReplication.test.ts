/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Holds `createWasReplication` to RxDB's default deleted flag. The push
 * handler, the conflict entries, and the feed primary read all branch on
 * `_deleted`, and RxDB swaps that member for its configured `deletedField` on
 * every row before the handlers see it, so a replication under any other field
 * would push a local delete as a content write of the tombstone's body. The
 * option is therefore not exposed, and the state RxDB returns runs under
 * `_deleted`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createRxDatabase, type RxDatabase } from 'rxdb/plugins/core'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { createWasReplication } from '../../src/wasReplication.js'
import { syncedDocSchema } from '../../src/syncedDocSchema.js'
import { stubSyncPort } from '../../src/testing.js'

let db: RxDatabase | undefined

afterEach(async () => {
  await db?.close()
  db = undefined
})

describe('createWasReplication deleted flag', () => {
  it('runs the replication under RxDB default `_deleted`', async () => {
    db = await createRxDatabase({
      name: `deltest-${randomUUID()}`,
      storage: getRxStorageMemory(),
      multiInstance: false
    })
    const { synced } = await db.addCollections({
      synced: { schema: syncedDocSchema() }
    })
    const replication = createWasReplication({
      rxCollection: synced,
      wasPort: stubSyncPort(),
      replicationIdentifier: 'deltest',
      autoStart: false
    })
    expect(replication.deletedField).toBe('_deleted')
    await replication.cancel()
  })

  it('exposes no `deletedField` option', () => {
    expectTypeOf<
      Parameters<typeof createWasReplication>[0]
    >().not.toHaveProperty('deletedField')
  })
})
