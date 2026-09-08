/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { beforeEach, describe, it, expect } from 'vitest'
import { captureLogger } from '@interop/logger'

import type { Json, SyncedDoc, WithDeleted } from '../../src/types.js'
import { setLogger } from '../../src/log.js'
import {
  lwwResolver,
  makeConflictHandler,
  makeLwwConflictHandler
} from '../../src/conflictHandler.js'

// The marker body an "unreadable" envelope carries: the epoch-aware fake cipher
// below throws for it, standing in for an envelope written under a key epoch
// this client has not seen.
const SEALED = 'sealed-under-an-unseen-epoch'

// A fake cipher whose "envelope" is just the plaintext payload wrapped in
// `{ jwe: payload }`; decrypt unwraps it. Lets us drive the handler's LWW
// decision without real crypto.
const decrypt = async (envelope: Json): Promise<Json> => {
  const { jwe } = envelope as { jwe: Json }
  if (jwe === SEALED) {
    // Shaped like the real UnknownEpochError (matched by `err.name`, the
    // cross-package rule): the decrypt THROWS rather than returning a payload
    // with no LWW stamp.
    const err = new Error('Unknown key epoch "e9".')
    err.name = 'UnknownEpochError'
    throw err
  }
  return jwe
}

function row(
  payload: { updatedAt: string; writerId: string } | null,
  {
    deleted = false,
    version = 0,
    metaVersion,
    custom
  }: {
    deleted?: boolean
    version?: number
    metaVersion?: number
    custom?: Json
  } = {}
): WithDeleted<SyncedDoc> {
  const doc: WithDeleted<SyncedDoc> = {
    id: 'r1',
    updatedAt: '2026-01-01T00:00:00Z',
    version,
    _deleted: deleted
  }
  if (payload !== null) {
    doc.data = { jwe: payload } as unknown as Json
  }
  if (metaVersion !== undefined) {
    doc.metaVersion = metaVersion
  }
  if (custom !== undefined) {
    doc.custom = custom
  }
  return doc
}

/**
 * A live row whose body does not decrypt on this client (an envelope under an
 * unseen key epoch), as distinct from a tombstone or a body with no LWW stamp.
 */
function sealedRow(version = 0): WithDeleted<SyncedDoc> {
  return {
    id: 'r1',
    updatedAt: '2026-01-01T00:00:00Z',
    version,
    _deleted: false,
    data: { jwe: SEALED } as unknown as Json
  }
}

const handler = makeLwwConflictHandler(decrypt)

/**
 * The package's logging seam, captured per test. The three undecryptable-side
 * warnings are the only signal that a conflict was settled by presuming one
 * side newer rather than by comparing stamps, so they are asserted rather than
 * swallowed.
 */
let capture = captureLogger('sync')

beforeEach(() => {
  capture = captureLogger('sync')
  setLogger(capture.logger)
})

function logged(level: 'warn' | 'error') {
  return capture.events.filter(event => event.level === level)
}

describe('makeLwwConflictHandler', () => {
  it('isEqual is true only when body + deletion agree', () => {
    const a = row({ updatedAt: 't1', writerId: 'd1' })
    const b = row({ updatedAt: 't1', writerId: 'd1' })
    const c = row({ updatedAt: 't2', writerId: 'd1' })
    expect(handler.isEqual(a, b)).toBe(true)
    expect(handler.isEqual(a, c)).toBe(false)
    expect(handler.isEqual(a, { ...b, _deleted: true })).toBe(false)
  })

  it('isEqual is false when only the server revision differs (feed echo)', () => {
    // Our own write echoing back from the changes feed: byte-identical body,
    // but one revision ahead. It must NOT compare equal, so the local row
    // adopts the server version and later If-Match headers stay in step.
    const local = row({ updatedAt: 't1', writerId: 'd1' }, { version: 0 })
    const echo = row({ updatedAt: 't1', writerId: 'd1' }, { version: 1 })
    expect(handler.isEqual(local, echo)).toBe(false)
    expect(handler.isEqual(echo, { ...echo })).toBe(true)
    expect(handler.isEqual(echo, { ...echo, metaVersion: 1 })).toBe(false)
  })

  it('resolves to the later payload (remote wins)', async () => {
    const remote = row({ updatedAt: '2026-02-02T00:00:00Z', writerId: 'dB' })
    const local = row({ updatedAt: '2026-01-01T00:00:00Z', writerId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })

  it('resolves to the later payload (local wins)', async () => {
    const remote = row({ updatedAt: '2026-01-01T00:00:00Z', writerId: 'dB' })
    const local = row({ updatedAt: '2026-02-02T00:00:00Z', writerId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(local)
  })

  it('breaks an exact updatedAt tie by greater writerId', async () => {
    const remote = row({ updatedAt: 'T', writerId: 'dZ' })
    const local = row({ updatedAt: 'T', writerId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })

  it('keeps a live local edit over a remote tombstone', async () => {
    const remote = row(null, { deleted: true, version: 3 })
    const local = row({ updatedAt: 'T', writerId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(local)
  })

  it('defaults to the primary when incomparable (local tombstone)', async () => {
    const remote = row({ updatedAt: 'T', writerId: 'dB' }, { version: 2 })
    const local = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })

  it('re-asserts a local tombstone on a version-only conflict (delete after a synced create)', async () => {
    // The classic dropped-delete: the row's If-Match was one revision stale,
    // but the primary's content is exactly what this replica last synced. The
    // tombstone must survive resolution and be re-pushed -- not resurrect.
    const payload = { updatedAt: 'T', writerId: 'dA' }
    const assumed = row(payload, { version: 0 })
    const primary = row(payload, { version: 1 })
    const tombstone = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(tombstone)
  })

  it('re-asserts a local edit on a version-only conflict', async () => {
    const payload = { updatedAt: 'T1', writerId: 'dA' }
    const assumed = row(payload, { version: 0 })
    const primary = row(payload, { version: 1 })
    const edit = row({ updatedAt: 'T2', writerId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: edit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(edit)
  })

  it('lets a genuine remote edit beat a local tombstone (delete-vs-edit race)', async () => {
    // The primary's content REALLY changed since this replica last synced (a
    // concurrent edit on another client won the push race): the edit wins and
    // the entity resurrects, deterministically on every replica.
    const assumed = row({ updatedAt: 'T1', writerId: 'dA' }, { version: 1 })
    const primary = row({ updatedAt: 'T2', writerId: 'dB' }, { version: 2 })
    const tombstone = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(primary)
  })

  it('lets the real primary win for custom on a metadata-only conflict (no data change)', async () => {
    // Clients A and B both edit only `custom` of the same resource. A's
    // `/meta` write commits first (metaVersion bumps); B's putMeta 412s, so the
    // assembled primary carries A's committed `custom` with `data` unchanged.
    // The equal-`data` LWW payloads would tie and keep B's stale `custom`; rule
    // 2 instead adopts the server-committed metadata so A's edit is not lost.
    const payload = { updatedAt: 'T', writerId: 'dA' }
    const assumed = row(payload, {
      version: 3,
      metaVersion: 1,
      custom: { jwe: 'C0' }
    })
    const primary = row(payload, {
      version: 3,
      metaVersion: 2,
      custom: { jwe: 'Ca' }
    })
    const localEdit = row(payload, {
      version: 3,
      metaVersion: 1,
      custom: { jwe: 'Cb' }
    })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: localEdit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(primary)
  })

  it('re-asserts local state on a version-only conflict when custom is also unchanged', async () => {
    // Both `data` and `custom` match the assumed primary (only the revision
    // moved), so rule 1 fires even though metadata exists: keep the local edit.
    const payload = { updatedAt: 'T1', writerId: 'dA' }
    const assumed = row(payload, {
      version: 0,
      metaVersion: 1,
      custom: { jwe: 'C0' }
    })
    const primary = row(payload, {
      version: 1,
      metaVersion: 1,
      custom: { jwe: 'C0' }
    })
    const edit = row(
      { updatedAt: 'T2', writerId: 'dA' },
      { version: 0, metaVersion: 1, custom: { jwe: 'C0' } }
    )
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: edit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(edit)
  })

  it('adopts an undecryptable primary rather than re-pushing the older local payload', async () => {
    // The primary was written under a key epoch this client has not seen, so its
    // decrypt throws. It must NOT be scored as absent: an unreadable body is
    // presumed newer, so the primary is adopted and the older local payload is
    // not pushed over it.
    const primary = sealedRow(2)
    const local = row({ updatedAt: '2026-01-01T00:00:00Z', writerId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: local
    })
    expect(winner).toBe(primary)
    expect(logged('warn')).toHaveLength(1)
    // The warning names was-client's no-key class, so a reader can tell a
    // spent (or unwired) refresh from a key this reader was never given.
    expect(logged('warn')[0]?.data).toMatchObject({
      reason: 'unknown-epoch'
    })
  })

  it('re-asserts an undecryptable local row rather than dropping the local edit', async () => {
    // The mirror case: this replica cannot read its OWN row (e.g. it was
    // written under an epoch since rotated away). Dropping it for the primary
    // would silently lose the user's edit, so the local row is re-asserted.
    const primary = row(
      { updatedAt: '2026-02-02T00:00:00Z', writerId: 'dB' },
      {
        version: 2
      }
    )
    const local = sealedRow(1)
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: local
    })
    expect(winner).toBe(local)
    expect(logged('warn')).toHaveLength(1)
  })

  it('adopts the primary when neither side decrypts', async () => {
    const primary = sealedRow(2)
    const local = sealedRow(1)
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: local
    })
    expect(winner).toBe(primary)
    expect(logged('warn')).toHaveLength(1)
  })

  it('still treats a tombstone as absent, not as undecryptable', async () => {
    // Regression for the three-kind split: a tombstone has nothing to decrypt,
    // so the tombstone rules must still apply -- a live local edit beats a
    // remote tombstone, and a local tombstone loses to a real remote change --
    // with no warning logged.
    const localEdit = row({ updatedAt: '2026-01-01T00:00:00Z', writerId: 'dA' })
    expect(
      await handler.resolve({
        realMasterState: row(null, { deleted: true, version: 3 }),
        newDocumentState: localEdit
      })
    ).toBe(localEdit)

    const assumed = row({ updatedAt: 'T1', writerId: 'dA' }, { version: 1 })
    const primary = row({ updatedAt: 'T2', writerId: 'dB' }, { version: 2 })
    expect(
      await handler.resolve({
        realMasterState: primary,
        newDocumentState: row(null, { deleted: true }),
        assumedMasterState: assumed
      })
    ).toBe(primary)
    expect(logged('warn')).toEqual([])
  })

  it('re-asserts a local tombstone against a remote tombstone race (both deleted)', async () => {
    // A delete/delete race that 412s: the primary is already a tombstone with
    // no data, matching the assumed primary shape -- keeping either converges;
    // the version-only rule keeps the local one.
    const assumed = row(null, { deleted: true, version: 1 })
    const primary = row(null, { deleted: true, version: 2 })
    const tombstone = row(null, { deleted: true, version: 1 })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(tombstone)
  })
})

describe('makeConflictHandler', () => {
  it("returns the local state when the injected resolver answers 'local'", async () => {
    const handlerWithResolver = makeConflictHandler({
      resolve: async () => 'local'
    })
    const remote = row({ updatedAt: 'T2', writerId: 'dB' }, { version: 2 })
    const local = row({ updatedAt: 'T1', writerId: 'dA' }, { version: 1 })
    await expect(
      handlerWithResolver.resolve({
        realMasterState: remote,
        newDocumentState: local
      })
    ).resolves.toBe(local)
  })

  it("returns the remote state when the injected resolver answers 'remote'", async () => {
    const handlerWithResolver = makeConflictHandler({
      resolve: async () => 'remote'
    })
    const remote = row({ updatedAt: 'T2', writerId: 'dB' }, { version: 2 })
    const local = row({ updatedAt: 'T1', writerId: 'dA' }, { version: 1 })
    await expect(
      handlerWithResolver.resolve({
        realMasterState: remote,
        newDocumentState: local
      })
    ).resolves.toBe(remote)
  })

  it('hands the resolver the whole conflict input, assumed state included', async () => {
    const seen: Array<Record<string, unknown>> = []
    const handlerWithResolver = makeConflictHandler({
      resolve: async input => {
        seen.push(input as unknown as Record<string, unknown>)
        return 'remote'
      }
    })
    const assumed = row({ updatedAt: 'T1', writerId: 'dA' }, { version: 1 })
    const remote = row(
      { updatedAt: 'T1', writerId: 'dA' },
      {
        version: 2,
        custom: { label: 'from another client' } as unknown as Json
      }
    )
    const local = row({ updatedAt: 'T1', writerId: 'dA' }, { version: 1 })
    await handlerWithResolver.resolve({
      realMasterState: remote,
      newDocumentState: local,
      assumedMasterState: assumed
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.assumedMasterState).toBe(assumed)
    expect((seen[0]?.realMasterState as WithDeleted<SyncedDoc>).custom).toEqual(
      {
        label: 'from another client'
      }
    )
  })

  it('logs a resolver that throws through the seam, then rethrows', async () => {
    // RxDB treats a failed conflict resolution as fatal rather than
    // retryable, and the reason lives inside the injected decision, so the
    // handler says so through the app's logger on the way out.
    const boom = new Error('the cipher is gone')
    const handlerWithResolver = makeConflictHandler({
      resolve: async () => {
        throw boom
      }
    })
    const remote = row({ updatedAt: 'T2', writerId: 'dB' }, { version: 2 })
    await expect(
      handlerWithResolver.resolve({
        realMasterState: remote,
        newDocumentState: row({ updatedAt: 'T1', writerId: 'dA' })
      })
    ).rejects.toBe(boom)
    expect(logged('error')).toHaveLength(1)
    // The capture logger lifts `data.err` to the event's top-level `err`.
    expect(logged('error')[0]).toMatchObject({ data: { id: 'r1' }, err: boom })
  })

  it('warns from the packaged resolver at warn, not error', async () => {
    await handler.resolve({
      realMasterState: sealedRow(2),
      newDocumentState: row({ updatedAt: 'T1', writerId: 'dA' })
    })
    expect(logged('warn')).toHaveLength(1)
    expect(logged('error')).toEqual([])
  })

  it('keeps the default isEqual, and takes an injected one', () => {
    const equal = row({ updatedAt: 'T1', writerId: 'dA' }, { version: 1 })
    const echo = row({ updatedAt: 'T1', writerId: 'dA' }, { version: 2 })
    expect(
      makeConflictHandler({ resolve: async () => 'remote' }).isEqual(
        equal,
        echo
      )
    ).toBe(false)
    expect(
      makeConflictHandler({
        resolve: async () => 'remote',
        isEqual: () => true
      }).isEqual(equal, echo)
    ).toBe(true)
  })
})

describe('lwwResolver undecryptable scoring', () => {
  it('scores an undecryptable side apart from an absent one', async () => {
    const resolve = lwwResolver({ decrypt })
    const olderLocal = row({
      updatedAt: '2026-01-01T00:00:00Z',
      writerId: 'dA'
    })

    // An UNDECRYPTABLE remote is presumed newer: the remote wins even though
    // the local row carries a readable stamp.
    await expect(
      resolve({
        realMasterState: sealedRow(2),
        newDocumentState: olderLocal
      })
    ).resolves.toBe('remote')

    // A remote with NOTHING to compare (a tombstone) is absent, not
    // unreadable: the live local edit wins instead.
    await expect(
      resolve({
        realMasterState: row(null, { deleted: true, version: 2 }),
        newDocumentState: olderLocal
      })
    ).resolves.toBe('local')
  })

  it('warns through the seam with nothing reaching the console', async () => {
    const resolve = lwwResolver({ decrypt })
    await expect(
      resolve({
        realMasterState: sealedRow(2),
        newDocumentState: row({ updatedAt: 'T1', writerId: 'dA' })
      })
    ).resolves.toBe('remote')
    expect(logged('warn')).toHaveLength(1)
    expect(logged('warn')[0]?.msg).toContain('did not decrypt')
  })
})
