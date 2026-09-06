/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Controller-core unit tests, one per reconciled lifecycle decision: the
 * terminal stop latch, the start-failure unwind that rethrows without latching,
 * registration before subscription, the both-keys status callback, the
 * uncovered-collection skip, the auth escalation, the remote-change
 * subscription, the no-op reSync on a stopping instance, the default
 * replication identifier, and the stop that resolves after every cancel.
 *
 * `createWasReplication` is mocked, so no RxDB database is opened here: the
 * subject is the lifecycle around the replication states, not the states
 * themselves (the integration suite drives a real one).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WasClient } from '@interop/was-client'
import { WasSyncAuthError } from '@interop/was-client/sync'
import { memoryOnlineSource, memorySchedule } from '../../src/testing.js'

const createWasReplication = vi.fn()

vi.mock('../../src/wasReplication.js', () => ({
  createWasReplication: (...args: unknown[]) => createWasReplication(...args)
}))

const { createSyncController, isAuthError } =
  await import('../../src/controller.js')

/**
 * A minimal observable: `subscribe` records the callback and returns an
 * unsubscribe, `emit` fires every live callback.
 */
function stream<Value>(): {
  subscribe: (handler: (value: Value) => void) => { unsubscribe: () => void }
  emit: (value: Value) => void
  live: () => number
} {
  const handlers = new Set<(value: Value) => void>()
  return {
    subscribe(handler) {
      handlers.add(handler)
      return {
        unsubscribe() {
          handlers.delete(handler)
        }
      }
    },
    emit(value) {
      for (const handler of [...handlers]) {
        handler(value)
      }
    },
    live: () => handlers.size
  }
}

/**
 * A stand-in for one `RxReplicationState`, with its two observed streams, a
 * `cancel` that records its call order, and a `reSync` spy.
 */
function fakeReplication(cancelOrder: string[], name: string) {
  return {
    name,
    active$: stream<boolean>(),
    error$: stream<unknown>(),
    reSync: vi.fn(),
    cancel: vi.fn(async () => {
      cancelOrder.push(name)
    })
  }
}

/**
 * A WAS client the sync port can be constructed over. Port construction is
 * I/O-free, and nothing here is ever called.
 */
const wasClient = {
  space: () => ({ collection: () => ({}) })
} as unknown as WasClient

function fakeRxCollection() {
  return { $: stream<unknown>() }
}

function capturingLog(): {
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
  warnings: string[]
  errors: string[]
} {
  const warnings: string[] = []
  const errors: string[] = []
  return {
    warnings,
    errors,
    warn: message => {
      warnings.push(message)
    },
    error: message => {
      errors.push(message)
    }
  }
}

beforeEach(() => {
  createWasReplication.mockReset()
})

describe('createSyncController lifecycle', () => {
  it('refuses a start queued behind a stop (stop is terminal)', async () => {
    const rxCollection = vi.fn(fakeRxCollection)
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [{ key: 'notes', id: 'notes' }],
        rxCollection: rxCollection as never
      },
      onStatus: () => {},
      pollMs: 0
    })

    // A logout stops the controller while a bootstrap is still deciding to
    // start; the start must not run against the closing database.
    const stopped = controller.stop()
    const started = controller.start()
    await Promise.all([stopped, started])

    expect(createWasReplication).not.toHaveBeenCalled()
    expect(rxCollection).not.toHaveBeenCalled()
  })

  it('reports both the logical key and the wire id on every status change', async () => {
    const cancelOrder: string[] = []
    const replication = fakeReplication(cancelOrder, 'notes')
    createWasReplication.mockReturnValue(replication)
    const statuses: Array<[string, string, string]> = []
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        // Two registry entries may share one WAS id, so the callback carries
        // both and neither binding has to map.
        collections: [{ key: 'wallet-notes', id: 'notes' }],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: (key, id, status) => statuses.push([key, id, status]),
      pollMs: 0
    })
    await controller.start()

    replication.active$.emit(true)
    replication.active$.emit(false)
    expect(statuses).toEqual([
      ['wallet-notes', 'notes', 'idle'],
      ['wallet-notes', 'notes', 'syncing'],
      ['wallet-notes', 'notes', 'synced']
    ])
    await controller.stop()
  })

  it('skips and flags a collection with no capability when its siblings carry one', async () => {
    const cancelOrder: string[] = []
    createWasReplication.mockReturnValue(fakeReplication(cancelOrder, 'notes'))
    const statuses: Array<[string, string]> = []
    const log = capturingLog()
    const rxCollection = vi.fn(fakeRxCollection)
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [
          {
            key: 'notes',
            id: 'notes',
            capability: { id: 'urn:zcap:1' } as never
          },
          { key: 'posts', id: 'posts' }
        ],
        rxCollection: rxCollection as never
      },
      onStatus: (key, _id, status) => statuses.push([key, status]),
      pollMs: 0,
      log
    })
    await controller.start()

    // Replicating the uncovered collection under no capability would draw a
    // fail-closed 403 and read as a session-wide access failure.
    expect(statuses).toContainEqual(['posts', 'error'])
    expect(createWasReplication).toHaveBeenCalledTimes(1)
    expect(rxCollection).toHaveBeenCalledExactlyOnceWith('notes')
    expect(log.warnings).toHaveLength(1)
    await controller.stop()
  })

  it('replicates every collection when no entry carries a capability', async () => {
    const cancelOrder: string[] = []
    createWasReplication.mockImplementation(() =>
      fakeReplication(cancelOrder, 'any')
    )
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [
          { key: 'notes', id: 'notes' },
          { key: 'posts', id: 'posts' }
        ],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: () => {},
      pollMs: 0
    })
    await controller.start()
    expect(createWasReplication).toHaveBeenCalledTimes(2)
    await controller.stop()
  })

  it('builds a replication identifier carrying the server URL and the Space id', async () => {
    const cancelOrder: string[] = []
    createWasReplication.mockReturnValue(fakeReplication(cancelOrder, 'notes'))
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [{ key: 'notes', id: 'notes' }],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: () => {},
      pollMs: 0
    })
    await controller.start()

    // RxDB persists checkpoints under this id inside the database, so an
    // identifier with no Space in it would resume another Space's checkpoint.
    expect(createWasReplication.mock.calls[0]?.[0]).toMatchObject({
      replicationIdentifier: 'was-sync:https://was.example:space-1:notes'
    })
    await controller.stop()
  })

  it('takes an overridden replication identifier', async () => {
    const cancelOrder: string[] = []
    createWasReplication.mockReturnValue(fakeReplication(cancelOrder, 'notes'))
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [{ key: 'notes', id: 'notes' }],
        rxCollection: (() => fakeRxCollection()) as never,
        replicationIdentifier: ({ collectionId }) => `custom:${collectionId}`
      },
      onStatus: () => {},
      pollMs: 0
    })
    await controller.start()
    expect(createWasReplication.mock.calls[0]?.[0]).toMatchObject({
      replicationIdentifier: 'custom:notes'
    })
    await controller.stop()
  })
})

describe('createSyncController failed bring-up', () => {
  it('flags every collection, rethrows, and stays re-startable', async () => {
    const log = capturingLog()
    createWasReplication.mockImplementation(() => {
      throw new Error('database closed')
    })
    const statuses: Array<[string, string]> = []
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [
          { key: 'notes', id: 'notes' },
          { key: 'posts', id: 'posts' }
        ],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: (key, _id, status) => statuses.push([key, status]),
      pollMs: 0,
      log
    })

    await expect(controller.start()).rejects.toThrow('database closed')
    expect(statuses).toContainEqual(['notes', 'error'])
    expect(statuses).toContainEqual(['posts', 'error'])
    expect(log.errors).toHaveLength(1)

    // Not latched: a later start runs its body again rather than no-opping.
    await expect(controller.start()).rejects.toThrow('database closed')
    expect(createWasReplication).toHaveBeenCalledTimes(2)
  })

  it('cancels the replications it already registered', async () => {
    const cancelOrder: string[] = []
    const first = fakeReplication(cancelOrder, 'notes')
    createWasReplication
      .mockReturnValueOnce(first)
      .mockImplementationOnce(() => {
        throw new Error('database closed')
      })
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [
          { key: 'notes', id: 'notes' },
          { key: 'posts', id: 'posts' }
        ],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: () => {},
      pollMs: 0
    })

    // The registration happens before the subscriptions, so a throw anywhere
    // after construction still leaves a replication the unwind can cancel.
    await expect(controller.start()).rejects.toThrow('database closed')
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(first.active$.live()).toBe(0)
    expect(first.error$.live()).toBe(0)
  })
})

describe('createSyncController error escalation', () => {
  it('fires onAuthError for an auth signal wrapped in an RxDB error graph', async () => {
    const cancelOrder: string[] = []
    const replication = fakeReplication(cancelOrder, 'notes')
    createWasReplication.mockReturnValue(replication)
    const onAuthError = vi.fn()
    const log = capturingLog()
    const statuses: string[] = []
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [{ key: 'notes', id: 'notes' }],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: (_key, _id, status) => statuses.push(status),
      onAuthError,
      pollMs: 0,
      log
    })
    await controller.start()

    replication.error$.emit({
      code: 'RC_PULL',
      parameters: { errors: [new WasSyncAuthError(403)] }
    })
    expect(onAuthError).toHaveBeenCalledOnce()
    expect(statuses).toContain('error')
    expect(log.errors).toHaveLength(1)

    replication.error$.emit(new Error('network down'))
    expect(onAuthError).toHaveBeenCalledOnce()
    await controller.stop()
  })

  it('recognises the plain-JSON form RxDB serializes a handler error to', () => {
    // RxDB's wrapping runs the thrown error through `errorToPlainJson`, so no
    // instance survives and only the name is left to match on.
    expect(
      isAuthError({
        code: 'RC_PUSH',
        parameters: {
          errors: [
            {
              name: 'WasSyncAuthError',
              message: 'WAS storage access denied (HTTP 403).'
            }
          ]
        }
      })
    ).toBe(true)
    expect(isAuthError({ cause: { cause: new WasSyncAuthError(401) } })).toBe(
      true
    )
    expect(isAuthError(new Error('network down'))).toBe(false)
  })

  it('tolerates a cycle in the error graph', () => {
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(isAuthError(cyclic)).toBe(false)
  })
})

describe('createSyncController remote change', () => {
  it('fires onRemoteChange off the collection stream', async () => {
    const cancelOrder: string[] = []
    createWasReplication.mockReturnValue(fakeReplication(cancelOrder, 'notes'))
    const collection = fakeRxCollection()
    const onRemoteChange = vi.fn()
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [{ key: 'notes', id: 'notes' }],
        rxCollection: (() => collection) as never
      },
      onStatus: () => {},
      onRemoteChange,
      pollMs: 0
    })
    await controller.start()

    // The collection stream rather than the replication's pull-only stream:
    // a push whose conflict resolution rewrote the local row fires here too.
    collection.$.emit({ operation: 'UPDATE' })
    expect(onRemoteChange).toHaveBeenCalledWith('notes', {
      operation: 'UPDATE'
    })
    await controller.stop()
    expect(collection.$.live()).toBe(0)
  })
})

describe('createSyncController polling and reachability', () => {
  it('polls through the injected schedule and skips a tick while offline', async () => {
    const cancelOrder: string[] = []
    const replication = fakeReplication(cancelOrder, 'notes')
    createWasReplication.mockReturnValue(replication)
    const schedule = memorySchedule()
    const online = memoryOnlineSource()
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [{ key: 'notes', id: 'notes' }],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: () => {},
      schedule,
      onlineSource: online,
      pollMs: 30_000
    })
    await controller.start()

    schedule.tick()
    expect(replication.reSync).toHaveBeenCalledTimes(1)

    online.setOnline(false)
    schedule.tick()
    expect(replication.reSync).toHaveBeenCalledTimes(1)

    // Reconnecting resyncs at once rather than waiting out the backoff.
    online.goOnline()
    expect(replication.reSync).toHaveBeenCalledTimes(2)

    await controller.stop()
    expect(schedule.pending()).toBe(0)
    schedule.tick()
    expect(replication.reSync).toHaveBeenCalledTimes(2)
  })

  it('registers no timer when pollMs is 0', async () => {
    const cancelOrder: string[] = []
    createWasReplication.mockReturnValue(fakeReplication(cancelOrder, 'notes'))
    const schedule = memorySchedule()
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [{ key: 'notes', id: 'notes' }],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: () => {},
      schedule,
      pollMs: 0
    })
    await controller.start()
    expect(schedule.pending()).toBe(0)
    await controller.stop()
  })
})

describe('createSyncController stop', () => {
  it('resolves after every registered replication has been cancelled', async () => {
    const cancelOrder: string[] = []
    const notes = fakeReplication(cancelOrder, 'notes')
    const posts = fakeReplication(cancelOrder, 'posts')
    createWasReplication.mockReturnValueOnce(notes).mockReturnValueOnce(posts)
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [
          { key: 'notes', id: 'notes' },
          { key: 'posts', id: 'posts' }
        ],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: () => {},
      pollMs: 0
    })
    await controller.start()
    await controller.stop()

    // The weaker true property: `cancel()` awaits RxDB's start and checkpoint
    // queues, not an in-flight round trip, so a handler whose response lands
    // after this can still write once.
    expect(cancelOrder).toEqual(['notes', 'posts'])
    expect(notes.active$.live()).toBe(0)
    expect(posts.error$.live()).toBe(0)
  })

  it('makes reSync a no-op once stopping, and survives a cancel that throws', async () => {
    const cancelOrder: string[] = []
    const replication = fakeReplication(cancelOrder, 'notes')
    replication.cancel = vi.fn(async () => {
      throw new Error('already closed')
    })
    createWasReplication.mockReturnValue(replication)
    const log = capturingLog()
    const controller = createSyncController({
      port: {
        wasClient,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [{ key: 'notes', id: 'notes' }],
        rxCollection: (() => fakeRxCollection()) as never
      },
      onStatus: () => {},
      pollMs: 0,
      log
    })
    await controller.start()

    const stopping = controller.stop()
    controller.reSync()
    await stopping
    controller.reSync()

    expect(replication.reSync).not.toHaveBeenCalled()
    expect(log.errors).toHaveLength(1)
  })
})
