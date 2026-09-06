/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The `@interop/was-sync` root entry: the parts of the WAS replication driver
 * that carry no RxDB -- the synced-document wire and local shapes, the opaque
 * body helpers, the replica schema, the conflict-handler seam with its
 * last-write-wins default, and the writer-id mint.
 *
 * This entry is free of `rxdb` in its module graph AND in its emitted
 * declarations, so a consumer that reads shared collections without ever
 * building a replica resolves it with `rxdb` absent. The RxDB driver and the
 * controller core live on the `./rxdb` subpath; test fixtures live on
 * `./testing`, never here.
 *
 * The wire vocabulary, the sync port implementation, the error classes, and the
 * `err.name` predicates that classify them belong to `@interop/was-client/sync`
 * and are imported from there rather than re-exported here.
 */
export {
  bodiesEqual,
  copyOptionalBodyFields,
  lwwFields,
  type Json,
  type LwwFields,
  type OptionalBodyFields,
  type PrimaryReadCache,
  type PrimaryState,
  type SyncCheckpoint,
  type SyncedDoc,
  type SyncLogPort,
  type WasSyncBasePort,
  type WasSyncPort,
  type WireDoc,
  type WithDeleted
} from './types.js'
export { syncedDocSchema, type SyncedDocSchema } from './syncedDocSchema.js'
export {
  lwwResolver,
  makeConflictHandler,
  makeLwwConflictHandler,
  statesEqual,
  type ConflictHandler,
  type ConflictInput,
  type ConflictWinner
} from './conflictHandler.js'
export {
  clearPersistedWriterId,
  getWriterId,
  type WriterIdStorage
} from './writerId.js'
