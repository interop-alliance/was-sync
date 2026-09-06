/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The controller core: the lifecycle around background WAS replication for one
 * session's set of collections.
 *
 * A local replica is the always-on active copy; `start()` spins up one
 * `replicateRxCollection` state machine per collection against the remote WAS
 * Space. Reachability is not probed separately -- the replication attempt is the
 * probe, and RxDB's `retryTime` backoff retries a down server and surfaces
 * failures on `error$`. Two explicit wires remain: the injected online source,
 * which fires `reSync()` on reconnect so a long-offline session recovers
 * promptly rather than waiting out the backoff, and the poll timer, which
 * re-runs the pull cycle because the server offers no live change stream yet.
 *
 * Everything that varies by app is injected. The collection set, the WAS
 * client, the delegated capabilities, and the local collection handles arrive
 * through one `port` object; status goes out through `onStatus` rather than into
 * a store, so a state-management library stays app-side; the online source and
 * the timer are ports, so the core reaches for neither `window` nor `navigator`
 * and a test drives both; and diagnostics go through the package's logging
 * seam (`setLogger`), which an app wires once at bootstrap.
 *
 * The lifecycle reconciles two properties the consuming apps each had one half
 * of. Every transition runs on a serialized FIFO queue, so an overlapping start
 * and stop can never interleave and leave a dangling replication. And `stop()`
 * is TERMINAL for an instance: a `start()` queued behind it is refused rather
 * than run against a database the caller is about to close. A session that
 * needs to replicate again constructs a fresh controller.
 */
import type { RxChangeEvent, RxCollection } from 'rxdb/plugins/core'
import type { RxReplicationState } from 'rxdb/plugins/replication'
import type { IZcap, WasClient } from '@interop/was-client'
import {
  createWasSyncPort,
  isSyncAuthError,
  type SyncStatus
} from '@interop/was-client/sync'
import type { SyncCheckpoint, SyncedDoc, WasSyncPort } from './types.js'
import { log } from './log.js'
import { createWasReplication } from './wasReplication.js'
import { withFeedPrimaryRead } from './feedPrimaryPort.js'

/**
 * The subset of an RxJS `Subscription` the core holds (rxjs is a transitive
 * dependency, so it is typed structurally rather than imported).
 */
type Unsubscribable = { unsubscribe: () => void }

/**
 * The timer port. Injected rather than reached for, so the core runs where
 * there is no DOM and a test can advance the poll without waiting.
 */
export interface SyncSchedule {
  setInterval: (handler: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

/**
 * The reachability port. `isOnline` gates the poll tick, and `subscribe`
 * registers a reconnect callback and returns its unsubscribe. An `isOnline`
 * that cannot answer MUST return `true`: a platform with no reachability signal
 * would otherwise never poll.
 */
export interface SyncOnlineSource {
  isOnline: () => boolean
  subscribe: (onOnline: () => void) => () => void
}

/**
 * A running controller. `start()` and `stop()` are serialized against each
 * other; `stop()` is terminal for this instance.
 */
export interface SyncController {
  start: () => Promise<void>
  stop: () => Promise<void>
  reSync: () => void
}

const defaultSchedule: SyncSchedule = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: handle =>
    clearInterval(handle as Parameters<typeof clearInterval>[0])
}

/**
 * Whether a replication error signals expired or revoked storage access. Every
 * WAS request the replication makes funnels through the sync port, which (under
 * `mapAuthErrors`) maps a `401` / `403` / masked `404` to was-client's
 * `WasSyncAuthError` at the boundary. RxDB then wraps that thrown error inside
 * an RxError (nested under `cause` / `errors` / `parameters.errors`), so this
 * walks the error graph looking for the signal rather than re-extracting raw
 * status codes.
 *
 * The leaf test is `isSyncAuthError`, a name check: RxDB's wrapping serializes
 * the handler's thrown error to plain JSON (name, message, stack -- through
 * `errorToPlainJson`), so a live instance never survives the wrapping, and a
 * second resolved copy of was-client would defeat an `instanceof`.
 *
 * @param err {unknown}
 * @returns {boolean}
 */
export function isAuthError(err: unknown): boolean {
  const seen = new Set<unknown>()
  const queue: unknown[] = [err]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === null || typeof current !== 'object' || seen.has(current)) {
      continue
    }
    seen.add(current)
    if (isSyncAuthError(current)) {
      return true
    }
    const candidate = current as {
      cause?: unknown
      parameters?: { errors?: unknown[] }
      errors?: unknown[]
    }
    if (candidate.cause) {
      queue.push(candidate.cause)
    }
    if (Array.isArray(candidate.errors)) {
      queue.push(...candidate.errors)
    }
    if (Array.isArray(candidate.parameters?.errors)) {
      queue.push(...candidate.parameters.errors)
    }
  }
  return false
}

/**
 * Builds a controller over one session's collections.
 *
 * The port is inlined at the signature because it is used once. Its members:
 * `wasClient` / `spaceId` / `serverUrl` locate the remote Space (and build the
 * default `replicationIdentifier`); each `collections` entry names a LOGICAL
 * key, the WAS collection id, and optionally the delegated capability every
 * request for that collection invokes; `rxCollection` resolves the local end by
 * logical key.
 *
 * The two port flags are deployment properties rather than app preferences.
 * `feedPrimaryRead` resolves the 412 conflict re-read from the changes-feed body
 * for a server that hides the ETag behind CORS ({@link withFeedPrimaryRead});
 * `mapAuthErrors` asks was-client's port for typed auth signals, which is what
 * `onAuthError` needs to fire.
 *
 * A collection with no `capability` in a port whose OTHER entries carry one is
 * skipped and flagged `error` rather than replicated under no capability: a
 * fail-closed 403 there would read as a session-wide access failure. A port
 * where no entry carries a capability invokes the client's own root capability
 * throughout, which is what a wallet client does.
 *
 * `pollMs` is required. Two consumers poll at different rates, and a package
 * default would silently change one app's background request rate.
 *
 * @param options {object}
 * @param options.port {object}                      the injected access seam
 * @param options.onStatus {(key, collectionId, status) => void}   both keys are
 *   delivered, so a store keyed on either needs no mapping
 * @param [options.onAuthError] {() => void}          fired when a replication
 *   error carries an auth signal
 * @param [options.onRemoteChange] {(key, event) => void}   fired per RxDB change
 *   event (a pull, or a conflict-resolved push rewrite)
 * @param [options.schedule] {SyncSchedule}
 * @param [options.onlineSource] {SyncOnlineSource}
 * @param options.pollMs {number}                     0 disables the poll timer
 * @returns {SyncController}
 */
export function createSyncController({
  port,
  onStatus,
  onAuthError,
  onRemoteChange,
  schedule = defaultSchedule,
  onlineSource,
  pollMs
}: {
  port: {
    wasClient: WasClient
    spaceId: string
    serverUrl: string
    collections: Array<{ key: string; id: string; capability?: IZcap }>
    rxCollection: (key: string) => RxCollection<SyncedDoc>
    replicationIdentifier?: (input: { collectionId: string }) => string
    batchSize?: number
    retryTime?: number
    feedPrimaryRead?: boolean
    mapAuthErrors?: boolean
  }
  onStatus: (key: string, collectionId: string, status: SyncStatus) => void
  onAuthError?: () => void
  onRemoteChange?: (key: string, event: RxChangeEvent<SyncedDoc>) => void
  schedule?: SyncSchedule
  onlineSource?: SyncOnlineSource
  pollMs: number
}): SyncController {
  const replications: Array<{
    state: RxReplicationState<SyncedDoc, SyncCheckpoint>
    subscriptions: Unsubscribable[]
  }> = []
  // A capability-less entry is only suspicious when its siblings carry one.
  const capabilityScoped = port.collections.some(
    entry => entry.capability !== undefined
  )
  const identifierFor =
    port.replicationIdentifier ??
    (({ collectionId }: { collectionId: string }) =>
      `was-sync:${port.serverUrl}:${port.spaceId}:${collectionId}`)

  let queue: Promise<void> = Promise.resolve()
  let started = false
  let stopped = false
  let pollTimer: unknown
  let unsubscribeOnline: (() => void) | undefined

  /**
   * Serializes a lifecycle task after any in-flight one. The chain's copy of a
   * rejection is swallowed so one failure cannot wedge every later transition;
   * the returned promise still carries this task's own outcome to its caller.
   */
  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = queue.then(task, task)
    queue = next.catch(() => {})
    return next
  }

  function reSync(): void {
    // A tick that lands on a stopping or stopped instance is a no-op.
    if (stopped) {
      return
    }
    for (const { state } of replications) {
      state.reSync()
    }
  }

  /**
   * The shared release path behind the failed-bring-up unwind and `stop()`:
   * drops the online subscription and the poll timer, unsubscribes every
   * per-collection subscription, and cancels every registered replication.
   *
   * What it guarantees is bounded by RxDB's own `cancel()`, which awaits the
   * start and checkpoint queues rather than an in-flight pull or push round
   * trip. A handler whose HTTP response lands after this resolves can still
   * write once into the collection.
   */
  async function teardown(): Promise<void> {
    if (unsubscribeOnline !== undefined) {
      unsubscribeOnline()
      unsubscribeOnline = undefined
    }
    if (pollTimer !== undefined) {
      schedule.clearInterval(pollTimer)
      pollTimer = undefined
    }
    for (const { state, subscriptions } of replications) {
      for (const subscription of subscriptions) {
        subscription.unsubscribe()
      }
      try {
        await state.cancel()
      } catch (err) {
        log.error('Error cancelling replication', { err })
      }
    }
    replications.length = 0
  }

  async function startOnce(): Promise<void> {
    if (started || stopped) {
      return
    }
    started = true
    try {
      for (const { key, id, capability } of port.collections) {
        if (capabilityScoped && capability === undefined) {
          log.warn('Skipping sync: no delegated capability covers it', { id })
          onStatus(key, id, 'error')
          continue
        }
        onStatus(key, id, 'idle')
        const basePort = createWasSyncPort({
          was: port.wasClient,
          spaceId: port.spaceId,
          collectionId: id,
          ...(capability !== undefined && { capability }),
          ...(port.mapAuthErrors !== undefined && {
            mapAuthErrors: port.mapAuthErrors
          })
        }) as unknown as WasSyncPort
        if (typeof basePort.putMeta !== 'function') {
          throw new Error(
            `Sync port for collection ${id} has no putMeta; the driver needs one`
          )
        }
        const wasPort =
          port.feedPrimaryRead === true
            ? withFeedPrimaryRead(basePort)
            : basePort
        const state = createWasReplication({
          rxCollection: port.rxCollection(key),
          wasPort,
          replicationIdentifier: identifierFor({ collectionId: id }),
          ...(port.batchSize !== undefined && { batchSize: port.batchSize }),
          ...(port.retryTime !== undefined && { retryTime: port.retryTime })
        })
        // Registered BEFORE anything is subscribed: `createWasReplication`
        // defaults to `autoStart`, so a throw between construction and
        // registration would leave a live replication `stop()` cannot reach.
        const entry = {
          state,
          subscriptions: [] as Unsubscribable[]
        }
        replications.push(entry)

        entry.subscriptions.push(
          state.active$.subscribe(active => {
            onStatus(key, id, active ? 'syncing' : 'synced')
          }),
          state.error$.subscribe(err => {
            log.error('Sync error for collection', { id, err })
            onStatus(key, id, 'error')
            if (onAuthError !== undefined && isAuthError(err)) {
              onAuthError()
            }
          })
        )
        if (onRemoteChange !== undefined) {
          // The collection stream rather than the replication's `received$`:
          // it also fires for a document rewritten by conflict resolution on
          // the push path, which a pull-only stream misses, so the losing
          // side's view would otherwise keep its stale local edit.
          entry.subscriptions.push(
            port
              .rxCollection(key)
              .$.subscribe(event => onRemoteChange(key, event))
          )
        }
      }

      if (onlineSource !== undefined) {
        unsubscribeOnline = onlineSource.subscribe(() => reSync())
      }
      // The pull side has no server-side live stream, so an already-open
      // session would otherwise never see another client's edits.
      if (pollMs > 0) {
        pollTimer = schedule.setInterval(() => {
          if (onlineSource === undefined || onlineSource.isOnline()) {
            reSync()
          }
        }, pollMs)
      }
    } catch (err) {
      log.error('Failed to start sync controller', { err })
      // Unwind the partial bring-up WITHOUT stopping: the terminal latch would
      // permanently refuse a later start on this instance, and a status reset
      // would report "not replicating" over a session that failed to start.
      // The per-collection statuses stay at `error` and the failure RETHROWS,
      // so the caller's bootstrap can surface it.
      await teardown()
      started = false
      for (const { key, id } of port.collections) {
        onStatus(key, id, 'error')
      }
      throw err
    }
  }

  return {
    start(): Promise<void> {
      return enqueue(startOnce)
    },
    stop(): Promise<void> {
      // Latch synchronously, before the queue: a start already queued behind
      // this stop is refused rather than run against a closing database.
      stopped = true
      return enqueue(async () => {
        await teardown()
        started = false
      })
    },
    reSync
  }
}
