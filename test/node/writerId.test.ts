/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the writer-id mint over its injected storage port: mint-once
 * per prefix, the clear that lets the next call mint a fresh one, prefix
 * isolation, and the storage that cannot answer (a fresh id per call, nothing
 * remembered).
 */
import { describe, expect, it } from 'vitest'
import {
  clearPersistedWriterId,
  getWriterId,
  type WriterIdStorage
} from '../../src/writerId.js'

/**
 * A `localStorage`-shaped map, which is all the mint asks for.
 *
 * @returns {WriterIdStorage & { entries: Map<string, string> }}
 */
function memoryStorage(): WriterIdStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
    removeItem: key => {
      entries.delete(key)
    }
  }
}

/**
 * A storage that throws on every access, as `localStorage` does in a browser
 * configured to block site data.
 */
const throwingStorage: WriterIdStorage = {
  getItem: () => {
    throw new Error('site data blocked')
  },
  setItem: () => {
    throw new Error('site data blocked')
  },
  removeItem: () => {
    throw new Error('site data blocked')
  }
}

describe('getWriterId', () => {
  it('mints once and returns the same id under the same prefix', () => {
    const storage = memoryStorage()
    const first = getWriterId({ storageKeyPrefix: 'freewallet:', storage })
    expect(first.length).toBeGreaterThan(0)
    expect(getWriterId({ storageKeyPrefix: 'freewallet:', storage })).toBe(
      first
    )
    expect(storage.entries.get('freewallet:writerId')).toBe(first)
  })

  it('keeps two prefixes apart', () => {
    const storage = memoryStorage()
    const wallet = getWriterId({ storageKeyPrefix: 'freewallet:', storage })
    const app = getWriterId({ storageKeyPrefix: 'myapp:', storage })
    expect(app).not.toBe(wallet)
    expect(storage.entries.get('myapp:writerId')).toBe(app)
  })

  it('mints a fresh id per call when the storage throws, remembering nothing', () => {
    // A remembered module-level fallback would stamp one label into two
    // accounts' histories in the same tab, so there is deliberately none.
    const first = getWriterId({
      storageKeyPrefix: 'freewallet:',
      storage: throwingStorage
    })
    const second = getWriterId({
      storageKeyPrefix: 'freewallet:',
      storage: throwingStorage
    })
    expect(first.length).toBeGreaterThan(0)
    expect(second).not.toBe(first)
  })
})

describe('clearPersistedWriterId', () => {
  it('removes the persisted id so a later mint produces a fresh one', () => {
    const storage = memoryStorage()
    const first = getWriterId({ storageKeyPrefix: 'freewallet:', storage })
    clearPersistedWriterId({ storageKeyPrefix: 'freewallet:', storage })
    expect(storage.entries.has('freewallet:writerId')).toBe(false)
    expect(getWriterId({ storageKeyPrefix: 'freewallet:', storage })).not.toBe(
      first
    )
  })

  it('clears only the named prefix', () => {
    const storage = memoryStorage()
    const app = getWriterId({ storageKeyPrefix: 'myapp:', storage })
    const wallet = getWriterId({ storageKeyPrefix: 'freewallet:', storage })
    clearPersistedWriterId({ storageKeyPrefix: 'myapp:', storage })
    expect(storage.entries.has('myapp:writerId')).toBe(false)
    expect(storage.entries.get('freewallet:writerId')).toBe(wallet)
    expect(app).not.toBe(wallet)
  })

  it('swallows a storage that throws', () => {
    expect(() =>
      clearPersistedWriterId({
        storageKeyPrefix: 'freewallet:',
        storage: throwingStorage
      })
    ).not.toThrow()
  })
})
