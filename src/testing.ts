/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * TEST FIXTURES ONLY, published as the `./testing` subpath so this package's
 * consumers drive their replication code against one shared reference
 * implementation instead of re-deriving fakes: a stateful in-memory WAS server,
 * a stub sync port, and memory implementations of the controller's timer and
 * reachability ports.
 *
 * Never import this subpath from production code. {@link FakeWasServer} ACCEPTS
 * EVERY WRITE and serves a plausible `changes` feed, so a production import
 * would show a healthy sync status over a replica writing nothing to WAS. Each
 * consumer keeps a lint restriction excluding `@interop/was-sync/testing` from
 * its non-test globs.
 */
import { WasSyncConflictError } from '@interop/was-client/sync'
import type {
  Json,
  PrimaryState,
  SyncCheckpoint,
  WasSyncPort,
  WireDoc
} from './types.js'
import type { SyncOnlineSource, SyncSchedule } from './controller.js'

/**
 * One resource as the fake server holds it.
 */
interface FakeResource {
  version: number
  metaVersion?: number
  updatedAt: string
  deleted: boolean
  data?: Json
  custom?: Json
  epoch?: string
  createdBy?: string
}

/**
 * A minimal stateful in-memory WAS server exposing a {@link WasSyncPort}:
 * ETag-conditional content and metadata writes, tombstones, and a keyset
 * `changes` feed. Documents are ordered by a monotonic tick used as
 * `updatedAt`, so the feed and its checkpoints behave like the real server's.
 *
 * It authorizes nothing and persists nothing. Test use only.
 */
export class FakeWasServer {
  #docs = new Map<string, FakeResource>()
  #tick = 0

  #nextUpdatedAt(): string {
    this.#tick += 1
    return String(this.#tick).padStart(12, '0')
  }

  /**
   * Seeds a document as if another client had written it.
   *
   * @param id {string}
   * @param data {Json}
   * @param [epoch] {string}
   * @returns {void}
   */
  seed(id: string, data: Json, epoch?: string): void {
    this.#docs.set(id, {
      version: 1,
      updatedAt: this.#nextUpdatedAt(),
      deleted: false,
      data,
      ...(epoch !== undefined && { epoch })
    })
  }

  /**
   * Whether the server holds a live (non-tombstoned) resource under `id`.
   *
   * @param id {string}
   * @returns {boolean}
   */
  has(id: string): boolean {
    const doc = this.#docs.get(id)
    return doc !== undefined && !doc.deleted
  }

  /**
   * The stored content body, or `undefined` when the server holds none.
   *
   * @param id {string}
   * @returns {Json | undefined}
   */
  dataFor(id: string): Json | undefined {
    return this.#docs.get(id)?.data
  }

  /**
   * The stored metadata body, or `undefined` when the server holds none.
   *
   * @param id {string}
   * @returns {Json | undefined}
   */
  customFor(id: string): Json | undefined {
    return this.#docs.get(id)?.custom
  }

  /**
   * The stored key-epoch stamp, or `undefined` when the server holds none.
   *
   * @param id {string}
   * @returns {string | undefined}
   */
  epochFor(id: string): string | undefined {
    return this.#docs.get(id)?.epoch
  }

  /**
   * The current content revision, or `undefined` for an unknown resource.
   *
   * @param id {string}
   * @returns {number | undefined}
   */
  versionFor(id: string): number | undefined {
    return this.#docs.get(id)?.version
  }

  /**
   * A port over this server. Conditional writes raise the conflict signal the
   * port contract requires.
   *
   * @param [options] {object}
   * @param [options.conflictError] {() => Error}   builds the 412 signal the
   *   port contract requires; defaults to was-client's
   *   `WasSyncConflictError`. Override it to raise a signal minted by another
   *   resolved copy of was-client, which is how the `err.name` matching rule
   *   is exercised.
   * @returns {WasSyncPort}
   */
  port({
    conflictError = () => new WasSyncConflictError()
  }: { conflictError?: () => Error } = {}): WasSyncPort {
    const docs = this.#docs
    const nextUpdatedAt = () => this.#nextUpdatedAt()
    const etagOf = (version: number) => `"${version}"`
    return {
      query: async ({ checkpoint, limit }) => {
        const ordered = [...docs.entries()]
          .map(([id, doc]) => ({ id, ...doc }))
          .sort((left, right) =>
            left.updatedAt === right.updatedAt
              ? left.id.localeCompare(right.id)
              : left.updatedAt.localeCompare(right.updatedAt)
          )
        const after = checkpoint
          ? ordered.filter(
              doc =>
                doc.updatedAt > checkpoint.updatedAt ||
                (doc.updatedAt === checkpoint.updatedAt &&
                  doc.id > checkpoint.id)
            )
          : ordered
        const page = after.slice(0, limit)
        const documents: WireDoc[] = page.map(doc => ({
          id: doc.id,
          _deleted: doc.deleted,
          updatedAt: doc.updatedAt,
          version: doc.version,
          ...(doc.metaVersion !== undefined && {
            metaVersion: doc.metaVersion
          }),
          ...(doc.epoch !== undefined && !doc.deleted && { epoch: doc.epoch }),
          ...(doc.data !== undefined && !doc.deleted && { data: doc.data }),
          ...(doc.custom !== undefined &&
            !doc.deleted && { custom: doc.custom })
        }))
        const last = page[page.length - 1]
        const nextCheckpoint: SyncCheckpoint | null = last
          ? { id: last.id, updatedAt: last.updatedAt }
          : null
        return { documents, checkpoint: nextCheckpoint }
      },

      putContent: async ({ id, data, ifMatch, ifNoneMatch, epoch }) => {
        const existing = docs.get(id)
        const live = existing !== undefined && !existing.deleted
        if (ifNoneMatch === true && live) {
          throw conflictError()
        }
        if (
          ifMatch !== undefined &&
          (existing === undefined || etagOf(existing.version) !== ifMatch)
        ) {
          throw conflictError()
        }
        // The port stands in for the `Key-Epoch` header the real server
        // stamps; an absent epoch leaves no stamp.
        const version = (existing?.version ?? 0) + 1
        docs.set(id, {
          version,
          updatedAt: nextUpdatedAt(),
          deleted: false,
          data,
          ...(existing?.metaVersion !== undefined && {
            metaVersion: existing.metaVersion
          }),
          ...(existing?.custom !== undefined && { custom: existing.custom }),
          ...(epoch !== undefined && { epoch })
        })
        return version
      },

      deleteContent: async ({ id, ifMatch }) => {
        const existing = docs.get(id)
        if (
          ifMatch !== undefined &&
          existing !== undefined &&
          etagOf(existing.version) !== ifMatch
        ) {
          throw conflictError()
        }
        const version = (existing?.version ?? 0) + 1
        docs.set(id, {
          version,
          updatedAt: nextUpdatedAt(),
          deleted: true
        })
        return version
      },

      putMeta: async ({ id, custom, ifMatch, ifNoneMatch }) => {
        const existing = docs.get(id)
        if (existing === undefined || existing.deleted) {
          // The server does not create a resource from a `/meta` write.
          throw conflictError()
        }
        if (ifNoneMatch === true && existing.metaVersion !== undefined) {
          throw conflictError()
        }
        if (
          ifMatch !== undefined &&
          (existing.metaVersion === undefined ||
            etagOf(existing.metaVersion) !== ifMatch)
        ) {
          throw conflictError()
        }
        const metaVersion = (existing.metaVersion ?? 0) + 1
        // A metadata replace clears every property the body omits, so an
        // absent `custom` writes the cleared state.
        delete existing.custom
        docs.set(id, {
          ...existing,
          metaVersion,
          updatedAt: nextUpdatedAt(),
          ...(custom !== undefined && { custom })
        })
        return metaVersion
      },

      get: async ({ id }) => {
        const doc = docs.get(id)
        if (doc === undefined || doc.deleted) {
          return null
        }
        const primary: PrimaryState = {
          version: doc.version,
          updatedAt: doc.updatedAt,
          deleted: false
        }
        if (doc.data !== undefined) {
          primary.data = doc.data
        }
        if (doc.custom !== undefined) {
          primary.custom = doc.custom
        }
        if (doc.metaVersion !== undefined) {
          primary.metaVersion = doc.metaVersion
        }
        if (doc.epoch !== undefined) {
          primary.epoch = doc.epoch
        }
        return primary
      }
    }
  }
}

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
 * calls `tick()`, so a poll cycle is driven rather than waited for.
 */
export interface MemorySchedule extends SyncSchedule {
  /** Runs every registered interval handler once. */
  tick: () => void
  /** How many intervals are currently registered. */
  pending: () => number
}

/**
 * Builds a {@link MemorySchedule}.
 *
 * @returns {MemorySchedule}
 */
export function memorySchedule(): MemorySchedule {
  const handlers = new Map<number, () => void>()
  let nextHandle = 1
  return {
    setInterval(handler: () => void): unknown {
      const handle = nextHandle++
      handlers.set(handle, handler)
      return handle
    },
    clearInterval(handle: unknown): void {
      handlers.delete(handle as number)
    },
    tick(): void {
      for (const handler of [...handlers.values()]) {
        handler()
      }
    },
    pending(): number {
      return handlers.size
    }
  }
}

/**
 * A memory {@link SyncOnlineSource} the test drives: `setOnline(false)` makes
 * the poll tick skip, and `goOnline()` fires every reconnect subscriber.
 */
export interface MemoryOnlineSource extends SyncOnlineSource {
  setOnline: (online: boolean) => void
  goOnline: () => void
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
    }
  }
}
