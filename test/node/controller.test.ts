/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Controller-core unit tests, one per reconciled lifecycle decision: the
 * terminal stop latch, the start-failure unwind that rethrows without latching,
 * registration before subscription, the both-keys status callback, the
 * uncovered-collection skip, the auth escalation, the remote-change
 * subscription, the no-op reSync on a stopping instance, the default
 * replication identifier, the sync port each replication is handed, the poll
 * rate and online unsubscription, and the stop that resolves after every
 * cancel.
 *
 * `createWasReplication` is mocked, so no RxDB database is opened here: the
 * subject is the lifecycle around the replication states, not the states
 * themselves (the integration suite drives a real one).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogger } from '@interop/logger'
import type { WasClient } from '@interop/was-client'
import { isSyncAuthError, WasSyncAuthError } from '@interop/was-client/sync'
import { memoryOnlineSource, memorySchedule } from '../../src/testing.js'
import { setLogger } from '../../src/log.js'
import type { WasSyncPort } from '../../src/types.js'

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
 * `cancel` that records its call order, and a `reSync` spy. The cancel records
 * only after a macrotask deferral, the way RxDB's own `cancel()` awaits its
 * queues, so a caller that does not await it finishes before the record lands.
 */
function fakeReplication(cancelOrder: string[], name: string) {
  return {
    name,
    active$: stream<boolean>(),
    error$: stream<unknown>(),
    reSync: vi.fn(),
    cancel: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      cancelOrder.push(name)
    })
  }
}

/**
 * A fake replication whose `active$` throws on subscribe, standing in for a
 * failure after construction and registration but before the subscriptions.
 */
function throwingSubscribeReplication(cancelOrder: string[], name: string) {
  const replication = fakeReplication(cancelOrder, name)
  return {
    ...replication,
    active$: {
      ...replication.active$,
      subscribe(): never {
        throw new Error('subscribe failed')
      }
    }
  }
}

/**
 * A WAS client that records what each sync-port call hands it: the capability
 * on the collection handle the feed reads through, the feed reads themselves,
 * and every direct request. Every request rejects with a `403`, so a test can
 * read back which signal the port mapped it to.
 */
function recordingWasClient(): {
  client: WasClient
  collectionCapabilities: unknown[]
  changesCalls: () => number
  requests: Array<{ capability?: unknown; method: string; path: string }>
} {
  const collectionCapabilities: unknown[] = []
  const requests: Array<{
    capability?: unknown
    method: string
    path: string
  }> = []
  let changesCalls = 0
  const client = {
    space: () => ({
      collection: (_id: string, options: { capability?: unknown }) => {
        collectionCapabilities.push(options.capability)
        return {
          // was-client 0.89.0's sync port walks the feed through
          // `resourceChanges()`, one page per iteration; an empty feed is one
          // page with `checkpoint: null`.
          resourceChanges: async function* () {
            changesCalls++
            yield { documents: [], checkpoint: null }
          }
        }
      }
    }),
    request: async (request: {
      capability?: unknown
      method: string
      path: string
    }) => {
      requests.push(request)
      throw Object.assign(new Error('forbidden'), { status: 403 })
    }
  } as unknown as WasClient
  return {
    client,
    collectionCapabilities,
    changesCalls: () => changesCalls,
    requests
  }
}

/**
 * The `wasPort` the controller handed the Nth `createWasReplication` call.
 */
function handedPort(callIndex = 0): WasSyncPort {
  const options = createWasReplication.mock.calls[callIndex]?.[0] as {
    wasPort: WasSyncPort
  }
  return options.wasPort
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

/**
 * The package's logging seam, captured per test. The core logs through the
 * module-level logger rather than a per-call port, so a test installs a capture
 * logger before the run and reads the warn / error events back off it.
 */
let capture = captureLogger('sync')

function logged(level: 'warn' | 'error'): string[] {
  return capture.events
    .filter(event => event.level === level)
    .map(event => event.msg)
}

beforeEach(() => {
  createWasReplication.mockReset()
  capture = captureLogger('sync')
  setLogger(capture.logger)
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
      pollMs: 0
    })
    await controller.start()

    // Replicating the uncovered collection under no capability would draw a
    // fail-closed 403 and read as a session-wide access failure. The skipped
    // collection never passes through `idle` on its way to `error`.
    expect(statuses).toEqual([
      ['notes', 'idle'],
      ['posts', 'error']
    ])
    expect(createWasReplication).toHaveBeenCalledTimes(1)
    expect(rxCollection).toHaveBeenCalledExactlyOnceWith('notes')
    expect(logged('warn')).toHaveLength(1)
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

  it('hands the injected writerId to every replication, and none when absent', async () => {
    const cancelOrder: string[] = []
    createWasReplication.mockImplementation(() =>
      fakeReplication(cancelOrder, 'notes')
    )
    const build = (writerId?: string) =>
      createSyncController({
        port: {
          wasClient,
          spaceId: 'space-1',
          serverUrl: 'https://was.example',
          collections: [
            { key: 'notes', id: 'notes' },
            { key: 'tasks', id: 'tasks' }
          ],
          rxCollection: (() => fakeRxCollection()) as never
        },
        onStatus: () => {},
        pollMs: 0,
        ...(writerId !== undefined && { writerId })
      })

    const labeled = build('writer-a')
    await labeled.start()
    await labeled.stop()
    const unlabeled = build()
    await unlabeled.start()
    await unlabeled.stop()

    const options = createWasReplication.mock.calls.map(
      call => call[0] as { writerId?: string }
    )
    expect(options.map(option => option.writerId)).toEqual([
      'writer-a',
      'writer-a',
      undefined,
      undefined
    ])
    expect('writerId' in options[2]!).toBe(false)
  })
})

describe('createSyncController failed bring-up', () => {
  it('flags every collection, rethrows, and stays re-startable', async () => {
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
      pollMs: 0
    })

    await expect(controller.start()).rejects.toThrow('database closed')
    expect(statuses).toContainEqual(['notes', 'error'])
    expect(statuses).toContainEqual(['posts', 'error'])
    expect(logged('error')).toHaveLength(1)

    // Not latched: a later start runs its body again rather than no-opping.
    await expect(controller.start()).rejects.toThrow('database closed')
    expect(createWasReplication).toHaveBeenCalledTimes(2)
  })

  it('cancels the replications it already registered when a later construction throws', async () => {
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

    await expect(controller.start()).rejects.toThrow('database closed')
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(first.active$.live()).toBe(0)
    expect(first.error$.live()).toBe(0)
  })

  it('cancels a replication whose own subscription throws', async () => {
    const cancelOrder: string[] = []
    const first = throwingSubscribeReplication(cancelOrder, 'notes')
    createWasReplication.mockReturnValueOnce(first)
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

    // The registration happens before the subscriptions, so a throw from
    // subscribing still leaves a replication the unwind can cancel.
    await expect(controller.start()).rejects.toThrow('subscribe failed')
    expect(createWasReplication).toHaveBeenCalledOnce()
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(cancelOrder).toEqual(['notes'])
  })
})

describe('createSyncController error escalation', () => {
  it('fires onAuthError for an auth signal wrapped in an RxDB error graph', async () => {
    const cancelOrder: string[] = []
    const replication = fakeReplication(cancelOrder, 'notes')
    createWasReplication.mockReturnValue(replication)
    const onAuthError = vi.fn()
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
      pollMs: 0
    })
    await controller.start()

    replication.error$.emit({
      code: 'RC_PULL',
      parameters: { errors: [new WasSyncAuthError(403)] }
    })
    expect(onAuthError).toHaveBeenCalledOnce()
    expect(statuses).toContain('error')
    expect(logged('error')).toHaveLength(1)

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

describe('createSyncController sync port', () => {
  function build(
    client: WasClient,
    options: {
      capability?: unknown
      feedPrimaryRead?: boolean
      mapAuthErrors?: boolean
    } = {}
  ) {
    createWasReplication.mockImplementation(() => fakeReplication([], 'notes'))
    return createSyncController({
      port: {
        wasClient: client,
        spaceId: 'space-1',
        serverUrl: 'https://was.example',
        collections: [
          {
            key: 'notes',
            id: 'notes',
            ...(options.capability !== undefined && {
              capability: options.capability as never
            })
          }
        ],
        rxCollection: (() => fakeRxCollection()) as never,
        ...(options.feedPrimaryRead !== undefined && {
          feedPrimaryRead: options.feedPrimaryRead
        }),
        ...(options.mapAuthErrors !== undefined && {
          mapAuthErrors: options.mapAuthErrors
        })
      },
      onStatus: () => {},
      pollMs: 0
    })
  }

  it('resolves the conflict re-read from the changes feed under feedPrimaryRead', async () => {
    const was = recordingWasClient()
    const controller = build(was.client, { feedPrimaryRead: true })
    await controller.start()

    // The feed-read wrapper answers `get` by walking the feed, never by a
    // direct GET whose ETag header CORS may hide.
    expect(await handedPort().get({ id: 'r1' })).toBeNull()
    expect(was.changesCalls()).toBe(1)
    expect(was.requests).toEqual([])
    await controller.stop()
  })

  it('hands the base port through when feedPrimaryRead is off', async () => {
    const was = recordingWasClient()
    const controller = build(was.client, { feedPrimaryRead: false })
    await controller.start()

    // The base port's own `get` issues direct GETs and never reads the feed.
    await expect(handedPort().get({ id: 'r1' })).rejects.toThrow()
    expect(was.changesCalls()).toBe(0)
    expect(was.requests.map(request => request.method)).toContain('GET')
    await controller.stop()
  })

  it('invokes the collection capability on every request the port makes', async () => {
    const was = recordingWasClient()
    const capability = { id: 'urn:zcap:notes' }
    const controller = build(was.client, { capability })
    await controller.start()

    await expect(
      handedPort().putContent({ id: 'r1', data: { a: 1 } })
    ).rejects.toThrow()
    expect(was.collectionCapabilities).toEqual([capability])
    expect(was.requests).toHaveLength(1)
    expect(was.requests[0]!.capability).toBe(capability)
    await controller.stop()
  })

  it('asks the port for typed auth signals under mapAuthErrors, and not without it', async () => {
    const mapped = recordingWasClient()
    const mapping = build(mapped.client, { mapAuthErrors: true })
    await mapping.start()
    const mappedErr = await handedPort(0)
      .putContent({ id: 'r1', data: { a: 1 } })
      .catch((err: unknown) => err)
    await mapping.stop()

    const unmapped = recordingWasClient()
    const plain = build(unmapped.client)
    await plain.start()
    const plainErr = await handedPort(1)
      .putContent({ id: 'r1', data: { a: 1 } })
      .catch((err: unknown) => err)
    await plain.stop()

    // The same 403 reaches `onAuthError` only through the mapped signal.
    expect(isSyncAuthError(mappedErr)).toBe(true)
    expect(isSyncAuthError(plainErr)).toBe(false)
  })
})

describe('createSyncController polling and reachability', () => {
  it('polls at pollMs through the injected schedule, skips a tick while offline, and unsubscribes on stop', async () => {
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
    expect(schedule.intervalsMs()).toEqual([30_000])
    expect(online.subscribers()).toBe(1)

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
    // Unsubscribed outright, not merely muted by the stopped latch in reSync.
    expect(online.subscribers()).toBe(0)
    schedule.tick()
    online.goOnline()
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
    // Snapshot the record at the moment stop resolves: each fake cancel records
    // only after a macrotask, so a stop that did not await its cancels would
    // resolve while the record is still empty.
    let cancelledAtResolve: string[] = []
    await controller.stop().then(() => {
      cancelledAtResolve = [...cancelOrder]
    })

    // The weaker true property: `cancel()` awaits RxDB's start and checkpoint
    // queues, not an in-flight round trip, so a handler whose response lands
    // after this can still write once.
    expect(cancelledAtResolve).toEqual(['notes', 'posts'])
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

    const stopping = controller.stop()
    controller.reSync()
    await stopping
    controller.reSync()

    expect(replication.reSync).not.toHaveBeenCalled()
    expect(logged('error')).toHaveLength(1)
  })
})
