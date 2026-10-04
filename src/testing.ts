/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * TEST FIXTURES ONLY, published as the `./testing` subpath so this package's
 * consumers drive their replication code against shared fixtures instead of
 * re-deriving them: a stub sync port, and memory implementations of the
 * controller's timer and reachability ports.
 *
 * Never import this subpath from production code. Each consumer keeps a lint
 * restriction excluding `@interop/was-sync/testing` from its non-test globs.
 *
 * There is no fake WAS server here. The integration suite runs against a live
 * in-process `was-teaching-server`, so the server's conditional-write,
 * tombstone, and `changes`-feed behavior is exercised rather than modeled.
 */
import type { WasSyncPort } from './types.js'
import type { SyncOnlineSource, SyncSchedule } from './controller.js'

/**
 * A {@link WasSyncPort} whose methods are all present but refuse to be called,
 * except the ones the test supplies. Saves every unit suite from hand-writing
 * the four unused members, and turns an unexpected call into a named failure
 * rather than a `TypeError`.
 *
 * @param [overrides] {Partial<WasSyncPort>}
 * @returns {WasSyncPort}
 */
export function stubSyncPort(
  overrides: Partial<WasSyncPort> = {}
): WasSyncPort {
  const refuse = (method: string) => async (): Promise<never> => {
    throw new Error(`stubSyncPort: unexpected ${method} call.`)
  }
  return {
    query: refuse('query'),
    putContent: refuse('putContent'),
    deleteContent: refuse('deleteContent'),
    putMeta: refuse('putMeta'),
    get: refuse('get'),
    ...overrides
  } as WasSyncPort
}

/**
 * A memory {@link SyncSchedule}: registered intervals fire only when the test
 * calls `tick()`, so a poll cycle is driven rather than waited for. Each
 * registration's `ms` is recorded rather than honored, so a test can read back
 * the poll rate it asked for.
 */
export interface MemorySchedule extends SyncSchedule {
  /**
   * Runs every registered interval handler once.
   */
  tick: () => void
  /**
   * How many intervals are currently registered.
   */
  pending: () => number
  /**
   * The `ms` each currently registered interval was registered with, in
   * registration order.
   */
  intervalsMs: () => number[]
}

/**
 * Builds a {@link MemorySchedule}.
 *
 * @returns {MemorySchedule}
 */
export function memorySchedule(): MemorySchedule {
  const intervals = new Map<number, { handler: () => void; ms: number }>()
  let nextHandle = 1
  return {
    setInterval(handler: () => void, ms: number): unknown {
      const handle = nextHandle++
      intervals.set(handle, { handler, ms })
      return handle
    },
    clearInterval(handle: unknown): void {
      intervals.delete(handle as number)
    },
    tick(): void {
      for (const { handler } of [...intervals.values()]) {
        handler()
      }
    },
    pending(): number {
      return intervals.size
    },
    intervalsMs(): number[] {
      return [...intervals.values()].map(({ ms }) => ms)
    }
  }
}

/**
 * A memory {@link SyncOnlineSource} the test drives: `setOnline(false)` makes
 * the poll tick skip, `goOnline()` fires every reconnect subscriber, and
 * `subscribers()` counts the live ones, so a test can tell an unsubscribed
 * callback from one that fired into a no-op.
 */
export interface MemoryOnlineSource extends SyncOnlineSource {
  setOnline: (online: boolean) => void
  goOnline: () => void
  /**
   * How many reconnect callbacks are currently subscribed.
   */
  subscribers: () => number
}

/**
 * Builds a {@link MemoryOnlineSource}, online by default.
 *
 * @param [options] {object}
 * @param [options.online] {boolean}
 * @returns {MemoryOnlineSource}
 */
export function memoryOnlineSource({
  online = true
}: { online?: boolean } = {}): MemoryOnlineSource {
  let current = online
  const subscribers = new Set<() => void>()
  return {
    isOnline: () => current,
    subscribe(onOnline: () => void): () => void {
      subscribers.add(onOnline)
      return () => {
        subscribers.delete(onOnline)
      }
    },
    setOnline(value: boolean): void {
      current = value
    },
    goOnline(): void {
      current = true
      for (const subscriber of [...subscribers]) {
        subscriber()
      }
    },
    subscribers(): number {
      return subscribers.size
    }
  }
}
