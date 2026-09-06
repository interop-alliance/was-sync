/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The writer id: an unkeyed, clearable, unrecoverable attribution label saying
 * which writing agent produced a revision. Its only jobs are attributing
 * history and breaking last-write-wins ties. It is never an identity -- it
 * derives from no secret, and it can vanish and be re-minted with nothing
 * carried over.
 *
 * Both the key prefix and the storage are the caller's. The prefix is required,
 * so the package mints no default key that two apps could collide on, and the
 * storage is a port rather than a reach for `localStorage`, so the module loads
 * anywhere and a test needs no DOM.
 */
import { uuidv7 } from 'uuidv7'

/**
 * The three `localStorage`-shaped methods the mint uses. A browser binding
 * passes `localStorage` itself; a binding with no persistent store passes one
 * that throws or does nothing, and every call then mints a fresh id.
 */
export interface WriterIdStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/**
 * Returns this browser profile's writer id, minting and persisting one on a
 * miss, under the key `<storageKeyPrefix>writerId`.
 *
 * Where the storage cannot answer (it throws, or it is a stand-in with nothing
 * behind it) a fresh id is minted per call and nothing is remembered. A
 * remembered module-level fallback would stamp one label into two accounts'
 * histories in the same tab.
 *
 * @param options {object}
 * @param options.storageKeyPrefix {string}   the storage key prefix, e.g.
 *   `mywallet:`
 * @param options.storage {WriterIdStorage}
 * @returns {string}
 */
export function getWriterId({
  storageKeyPrefix,
  storage
}: {
  storageKeyPrefix: string
  storage: WriterIdStorage
}): string {
  const writerIdKey = `${storageKeyPrefix}writerId`
  try {
    const existing = storage.getItem(writerIdKey)
    if (existing) {
      return existing
    }
    const minted = uuidv7()
    storage.setItem(writerIdKey, minted)
    return minted
  } catch {
    return uuidv7()
  }
}

/**
 * Clears the persisted writer id, so the next mint under the same prefix
 * produces a fresh one. Consumed by the wipe grade that forgets a browser: the
 * id is account-agnostic, but it is still a browser-local "this client wrote
 * here" trace.
 *
 * @param options {object}
 * @param options.storageKeyPrefix {string}
 * @param options.storage {WriterIdStorage}
 * @returns {void}
 */
export function clearPersistedWriterId({
  storageKeyPrefix,
  storage
}: {
  storageKeyPrefix: string
  storage: WriterIdStorage
}): void {
  try {
    storage.removeItem(`${storageKeyPrefix}writerId`)
  } catch {
    // Nothing was persisted to clear.
  }
}
