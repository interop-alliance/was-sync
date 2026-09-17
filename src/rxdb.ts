/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The `@interop/was-sync/rxdb` entry: the RxDB half of the WAS replication
 * driver -- the pull and push handlers, the `replicateRxCollection` wiring with
 * its push-ack write-back, the opt-in feed-backed conflict re-read, and the
 * controller core that runs one session's collections.
 *
 * `rxdb` is this subpath's peer dependency and is needed only here; the root
 * entry stays free of it, in its module graph and in its declarations, so a
 * consumer that never builds a replica resolves the root with `rxdb` absent.
 *
 * A consumer whose eager bundle chunk must stay free of RxDB imports this
 * subpath dynamically, inside the session bootstrap that starts replicating.
 */
export { createPullHandler, wireDocToRxDoc } from './changesQuery.js'
export { createPushHandler, type PushWriteAck } from './pushWrites.js'
export { createWasReplication } from './wasReplication.js'
export { withFeedPrimaryRead } from './feedPrimaryPort.js'
export {
  createSyncController,
  isAuthError,
  type SyncController,
  type SyncOnlineSource,
  type SyncSchedule
} from './controller.js'
