/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { captureLogger } from '@interop/logger'

import type { Json, SyncedDoc, WithDeleted } from '../../src/types.js'
import { setLogger } from '../../src/log.js'
import { metaStamp } from './fixtures.js'
import {
  lwwResolver,
  makeConflictHandler,
  makeLwwConflictHandler,
  type ConflictDecrypt
} from '../../src/conflictHandler.js'

// The marker bodies an envelope this client cannot open carries. The fake
// cipher below throws a differently-named error for each, standing in for
// was-client's three decrypt failures: a key epoch this client has not seen, a
// key this client was never a recipient of, and an envelope written for a
// different resource than the one it is being read under.
const SEALED = 'sealed-under-an-unseen-epoch'
const UNWRAPPABLE = 'sealed-for-another-recipient'
const TAMPERED = 'written-for-another-resource'

// Every `{ id, envelope }` the fake cipher was called with, so a test can
// assert the resolver addresses each side by the ROW's id.
const decryptCalls: { id: string; envelope: Json; context?: unknown }[] = []

/**
 * A fake cipher whose "envelope" is just the plaintext payload wrapped in
 * `{ jwe: payload }`; decrypt unwraps it. Lets us drive the handler's LWW
 * decision without real crypto. The thrown errors are shaped like the real
 * was-client classes (matched by `err.name`, the cross-package rule): the
 * decrypt THROWS rather than returning a payload with no LWW stamp.
 */
const decrypt: ConflictDecrypt = async ({ id, envelope, context }) => {
  decryptCalls.push({ id, envelope, context })
  const { jwe } = envelope as { jwe: Json }
  if (jwe === SEALED) {
    const err = new Error('Unknown key epoch "e9".')
    err.name = 'UnknownEpochError'
    throw err
  }
  if (jwe === UNWRAPPABLE) {
    const err = new Error('Could not unwrap the content encryption key.')
    err.name = 'KeyUnwrapError'
    throw err
  }
  if (jwe === TAMPERED) {
    const err = new Error(`Envelope was not written for resource "${id}".`)
    err.name = 'IntegrityError'
    throw err
  }
  return jwe
}

function row(
  payload: { updatedAt: string; writerId: string } | null,
  {
    deleted = false,
    counter,
    originId,
    meta,
    custom,
    id = 'r1'
  }: {
    deleted?: boolean
    counter?: number
    originId?: string
    meta?: SyncedDoc['meta']
    custom?: Json
    id?: string
  } = {}
): WithDeleted<SyncedDoc> {
  const doc: WithDeleted<SyncedDoc> = {
    id,
    updatedAt: '2026-01-01T00:00:00Z',
    _deleted: deleted
  }
  if (payload !== null) {
    doc.data = { jwe: payload } as unknown as Json
  }
  if (counter !== undefined) {
    doc.updatedAtCounter = counter
  }
  if (originId !== undefined) {
    doc.originId = originId
  }
  if (meta !== undefined) {
    doc.meta = meta
  }
  if (custom !== undefined) {
    doc.custom = custom
  }
  return doc
}

/**
 * A live row carrying one of the marker bodies above, as distinct from a
 * tombstone or a body with no LWW stamp.
 */
function markerRow(marker: string): WithDeleted<SyncedDoc> {
  return {
    id: 'r1',
    updatedAt: '2026-01-01T00:00:00Z',
    _deleted: false,
    data: { jwe: marker } as unknown as Json
  }
}

/**
 * A live row whose body does not decrypt on this client (an envelope under an
 * unseen key epoch).
 */
function sealedRow(): WithDeleted<SyncedDoc> {
  return markerRow(SEALED)
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
  decryptCalls.length = 0
})

function logged(level: 'warn' | 'error') {
  return capture.events.filter(event => event.level === level)
}

describe('makeLwwConflictHandler', () => {
  it('isEqual is true only when data, custom, and deletion agree', () => {
    const a = row({ updatedAt: 't1', writerId: 'd1' })
    const b = row({ updatedAt: 't1', writerId: 'd1' })
    const c = row({ updatedAt: 't2', writerId: 'd1' })
    expect(handler.isEqual(a, b)).toBe(true)
    expect(handler.isEqual(a, c)).toBe(false)
    expect(handler.isEqual(a, { ...b, _deleted: true })).toBe(false)
    // A metadata-only difference: same content, a different `custom` body.
    const withCustom = row(
      { updatedAt: 't1', writerId: 'd1' },
      { custom: { jwe: 'C0' } }
    )
    expect(handler.isEqual(withCustom, { ...withCustom })).toBe(true)
    expect(
      handler.isEqual(withCustom, { ...withCustom, custom: { jwe: 'C1' } })
    ).toBe(false)
    expect(handler.isEqual(withCustom, a)).toBe(false)
  })

  it('isEqual is false when only the server stamp differs (feed echo)', () => {
    // Our own write echoing back from the changes feed: byte-identical body,
    // but one counter ahead. It must NOT compare equal, so the local row
    // adopts the server stamp and later If-Match headers stay in step.
    const local = row({ updatedAt: 't1', writerId: 'd1' }, { counter: 0 })
    const echo = row({ updatedAt: 't1', writerId: 'd1' }, { counter: 1 })
    expect(handler.isEqual(local, echo)).toBe(false)
    expect(handler.isEqual(echo, { ...echo })).toBe(true)
    expect(
      handler.isEqual(echo, {
        ...echo,
        meta: metaStamp()
      })
    ).toBe(false)
  })

  it('isEqual is false when only a server-managed member differs', () => {
    // The echo of this replica's own write, after the ack write-back has
    // already stamped `version` / `etag`: only what the server alone assigns
    // is left to differ, and each of those must still land in the local row.
    const stamped = row({ updatedAt: 't1', writerId: 'd1' }, { counter: 1 })
    stamped.etag = '"g1-1"'
    expect(handler.isEqual(stamped, { ...stamped })).toBe(true)
    expect(
      handler.isEqual(stamped, { ...stamped, createdBy: 'did:key:z6Mk' })
    ).toBe(false)
    expect(
      handler.isEqual(stamped, { ...stamped, updatedAt: '000000000009' })
    ).toBe(false)
    expect(handler.isEqual(stamped, { ...stamped, epoch: 'e2' })).toBe(false)
    expect(handler.isEqual(stamped, { ...stamped, etag: '"g1-2"' })).toBe(false)
    expect(handler.isEqual(stamped, { ...stamped, metaEtag: '"m1"' })).toBe(
      false
    )
    expect(handler.isEqual(stamped, { ...stamped, id: 'r2' })).toBe(false)
  })

  it('isEqual differs on updatedAtCounter and on originId', () => {
    const base = row(
      { updatedAt: 't1', writerId: 'd1' },
      { counter: 1, originId: 'o1' }
    )
    expect(handler.isEqual(base, { ...base })).toBe(true)
    expect(handler.isEqual(base, { ...base, updatedAtCounter: 2 })).toBe(false)
    expect(handler.isEqual(base, { ...base, originId: 'o2' })).toBe(false)
  })

  it('isEqual treats updatedAtCounter 0 as present, not absent', () => {
    const absent = row({ updatedAt: 't1', writerId: 'd1' })
    const zero = row({ updatedAt: 't1', writerId: 'd1' }, { counter: 0 })
    expect(absent.updatedAtCounter).toBeUndefined()
    expect(zero.updatedAtCounter).toBe(0)
    expect(handler.isEqual(absent, zero)).toBe(false)
    expect(handler.isEqual(zero, { ...zero })).toBe(true)
  })

  it('isEqual differs on each meta member', () => {
    const base = row({ updatedAt: 't1', writerId: 'd1' }, { meta: metaStamp() })
    expect(handler.isEqual(base, { ...base })).toBe(true)
    expect(handler.isEqual(base, { ...base, meta: undefined })).toBe(false)
    for (const overrides of [
      { updatedAt: '2026-02-02T00:00:00Z' },
      { updatedAtCounter: 2 },
      { originId: 'origin-other' },
      { generation: 'g2' }
    ]) {
      expect(
        handler.isEqual(base, {
          ...base,
          meta: metaStamp(overrides)
        })
      ).toBe(false)
    }
  })

  it('isEqual compares meta canonically, not by identity or key order', () => {
    const base = row({ updatedAt: 't1', writerId: 'd1' }, { meta: metaStamp() })
    const distinct = {
      ...base,
      meta: metaStamp()
    }
    expect(distinct.meta).not.toBe(base.meta)
    expect(handler.isEqual(base, distinct)).toBe(true)
    const reordered = {
      ...base,
      meta: {
        generation: 'gen-a',
        originId: 'origin-a',
        updatedAtCounter: 1,
        updatedAt: '2026-01-01T00:00:00Z'
      }
    }
    expect(handler.isEqual(base, reordered)).toBe(true)
    const extra = {
      ...base,
      meta: { ...metaStamp(), added: 'later' }
    } as unknown as WithDeleted<SyncedDoc>
    expect(handler.isEqual(base, extra)).toBe(false)
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
    // A tombstone has nothing to decrypt: it is absent, not undecryptable, so
    // the edit wins by the tombstone rule with no warning logged.
    const remote = row(null, { deleted: true, counter: 3 })
    const local = row({ updatedAt: 'T', writerId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(local)
    expect(logged('warn')).toEqual([])
  })

  it('defaults to the primary when incomparable (local tombstone)', async () => {
    const remote = row({ updatedAt: 'T', writerId: 'dB' }, { counter: 2 })
    const local = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })

  it('re-asserts a local tombstone on a validator-only conflict (delete after a synced create)', async () => {
    // The classic dropped-delete: the row's If-Match was one stamp stale,
    // but the primary's content is exactly what this replica last synced. The
    // tombstone must survive resolution and be re-pushed -- not resurrect.
    const payload = { updatedAt: 'T', writerId: 'dA' }
    const assumed = row(payload, { counter: 0 })
    const primary = row(payload, { counter: 1 })
    const tombstone = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(tombstone)
  })

  it('re-asserts a local edit on a validator-only conflict', async () => {
    // The edit's stamp is OLDER than the primary's, so rule 4 would pick the
    // primary: only the validator-only rule yields the local edit.
    const payload = { updatedAt: '2026-02-02T00:00:00Z', writerId: 'dB' }
    const assumed = row(payload, { counter: 0 })
    const primary = row(payload, { counter: 1 })
    const edit = row({ updatedAt: '2026-01-01T00:00:00Z', writerId: 'dA' })
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
    const assumed = row({ updatedAt: 'T1', writerId: 'dA' }, { counter: 1 })
    const primary = row({ updatedAt: 'T2', writerId: 'dB' }, { counter: 2 })
    const tombstone = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(primary)
    expect(logged('warn')).toEqual([])
  })

  it('lets the real primary win for custom on a metadata-only conflict (no data change)', async () => {
    // Clients A and B both edit only `custom` of the same resource. A's
    // `/meta` write commits first (the `meta` stamp advances); B's putMeta 412s, so the
    // assembled primary carries A's committed `custom` with `data` unchanged.
    // The equal-`data` LWW payloads would tie and keep B's stale `custom`; rule
    // 2 instead adopts the server-committed metadata so A's edit is not lost.
    const payload = { updatedAt: 'T', writerId: 'dA' }
    const assumed = row(payload, {
      counter: 3,
      meta: metaStamp(),
      custom: { jwe: 'C0' }
    })
    const primary = row(payload, {
      counter: 3,
      meta: metaStamp({ updatedAtCounter: 2 }),
      custom: { jwe: 'Ca' }
    })
    const localEdit = row(payload, {
      counter: 3,
      meta: metaStamp(),
      custom: { jwe: 'Cb' }
    })
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: localEdit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(primary)
  })

  it('re-asserts local state on a validator-only conflict when custom is also unchanged', async () => {
    // Both `data` and `custom` match the assumed primary (only the stamp
    // moved), so rule 1 fires even though metadata exists: keep the local edit.
    // The edit's stamp is OLDER than the primary's, so rule 4 would pick the
    // primary: only the validator-only rule yields the local edit.
    const payload = { updatedAt: '2026-02-02T00:00:00Z', writerId: 'dB' }
    const assumed = row(payload, {
      counter: 0,
      meta: metaStamp(),
      custom: { jwe: 'C0' }
    })
    const primary = row(payload, {
      counter: 1,
      meta: metaStamp(),
      custom: { jwe: 'C0' }
    })
    const edit = row(
      { updatedAt: '2026-01-01T00:00:00Z', writerId: 'dA' },
      {
        counter: 0,
        meta: metaStamp(),
        custom: { jwe: 'C0' }
      }
    )
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: edit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(edit)
  })

  it('rule 1 resolves local when the primary differs only in stamp members or meta', async () => {
    // Rules 1 and 2 compare bodies, not stamps. Each primary below moves a
    // stamp member the assumed one does not, with the bodies equal and an
    // older local edit that rule 4 would lose.
    const payload = { updatedAt: '2026-02-02T00:00:00Z', writerId: 'dB' }
    const assumed = row(payload, {
      counter: 1,
      originId: 'o1',
      meta: metaStamp(),
      custom: { jwe: 'C0' }
    })
    const variants = [
      { counter: 2 },
      { originId: 'o2' },
      { meta: metaStamp({ updatedAtCounter: 2 }) },
      { meta: metaStamp({ updatedAtCounter: 1, generation: 'g2' }) },
      { counter: 2, originId: 'o2', meta: metaStamp({ updatedAtCounter: 3 }) }
    ]
    for (const variant of variants) {
      const primary = row(payload, {
        counter: 1,
        originId: 'o1',
        meta: metaStamp(),
        custom: { jwe: 'C0' },
        ...variant
      })
      const edit = row(
        { updatedAt: '2026-01-01T00:00:00Z', writerId: 'dA' },
        { counter: 1, originId: 'o1', custom: { jwe: 'C0' } }
      )
      const winner = await handler.resolve({
        realMasterState: primary,
        newDocumentState: edit,
        assumedMasterState: assumed
      })
      expect(winner).toBe(edit)
    }
  })

  it('rule 2 resolves remote on a custom change whatever the stamps say', async () => {
    const payload = { updatedAt: 'T', writerId: 'dA' }
    const assumed = row(payload, {
      counter: 5,
      originId: 'o1',
      meta: metaStamp({ updatedAtCounter: 5 }),
      custom: { jwe: 'C0' }
    })
    for (const stamps of [
      { counter: 1, originId: 'o0', meta: metaStamp() },
      { counter: 9, originId: 'o9', meta: metaStamp({ updatedAtCounter: 9 }) },
      {}
    ]) {
      const primary = row(payload, { ...stamps, custom: { jwe: 'Ca' } })
      const edit = row(payload, {
        counter: 5,
        originId: 'o1',
        meta: metaStamp({ updatedAtCounter: 5 }),
        custom: { jwe: 'Cb' }
      })
      const winner = await handler.resolve({
        realMasterState: primary,
        newDocumentState: edit,
        assumedMasterState: assumed
      })
      expect(winner).toBe(primary)
    }
  })

  it('returns a local winner with its stale stamp members unchanged', async () => {
    const payload = { updatedAt: '2026-02-02T00:00:00Z', writerId: 'dB' }
    const assumed = row(payload, { counter: 1, originId: 'o1' })
    const primary = row(payload, { counter: 2, originId: 'o2' })
    const edit = row(
      { updatedAt: '2026-01-01T00:00:00Z', writerId: 'dA' },
      { counter: 1, originId: 'o1', meta: metaStamp() }
    )
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: edit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(edit)
    expect(winner.updatedAtCounter).toBe(1)
    expect(winner.originId).toBe('o1')
    expect(winner.meta).toEqual(metaStamp())
  })

  it('adopts an undecryptable primary rather than re-pushing the older local payload', async () => {
    // The primary was written under a key epoch this client has not seen, so its
    // decrypt throws. It must NOT be scored as absent: an unreadable body is
    // presumed newer, so the primary is adopted and the older local payload is
    // not pushed over it.
    const primary = sealedRow()
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
        counter: 2
      }
    )
    const local = sealedRow()
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: local
    })
    expect(winner).toBe(local)
    expect(logged('warn')).toHaveLength(1)
  })

  it('adopts the primary when neither side decrypts', async () => {
    const primary = sealedRow()
    const local = sealedRow()
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: local
    })
    expect(winner).toBe(primary)
    expect(logged('warn')).toHaveLength(1)
  })

  it('re-asserts a local tombstone against a remote tombstone race (both deleted)', async () => {
    // A delete/delete race that 412s: the primary is already a tombstone with
    // no data, matching the assumed primary shape -- keeping either converges;
    // the validator-only rule keeps the local one.
    const assumed = row(null, { deleted: true, counter: 1 })
    const primary = row(null, { deleted: true, counter: 2 })
    const tombstone = row(null, { deleted: true, counter: 1 })
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
    const remote = row({ updatedAt: 'T2', writerId: 'dB' }, { counter: 2 })
    const local = row({ updatedAt: 'T1', writerId: 'dA' }, { counter: 1 })
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
    const remote = row({ updatedAt: 'T2', writerId: 'dB' }, { counter: 2 })
    const local = row({ updatedAt: 'T1', writerId: 'dA' }, { counter: 1 })
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
    const assumed = row({ updatedAt: 'T1', writerId: 'dA' }, { counter: 1 })
    const remote = row(
      { updatedAt: 'T1', writerId: 'dA' },
      {
        counter: 2,
        custom: { label: 'from another client' } as unknown as Json
      }
    )
    const local = row({ updatedAt: 'T1', writerId: 'dA' }, { counter: 1 })
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
    const remote = row({ updatedAt: 'T2', writerId: 'dB' }, { counter: 2 })
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

  it('keeps the default isEqual, and takes an injected one', () => {
    const equal = row({ updatedAt: 'T1', writerId: 'dA' }, { counter: 1 })
    const echo = row({ updatedAt: 'T1', writerId: 'dA' }, { counter: 2 })
    const defaulted = makeConflictHandler({ resolve: async () => 'remote' })
    expect(defaulted.isEqual(equal, { ...equal })).toBe(true)
    expect(defaulted.isEqual(equal, echo)).toBe(false)
    expect(
      makeConflictHandler({
        resolve: async () => 'remote',
        isEqual: () => true
      }).isEqual(equal, echo)
    ).toBe(true)
  })
})

describe('lwwResolver decrypt addressing and integrity', () => {
  it("addresses each side by the row's own id, not the envelope's or the body's", async () => {
    // The cipher checks the envelope against the id it is read under, so the
    // addressed id has to come from the ROW. An id read back out of the
    // decrypted body would check the envelope against itself.
    const resolve = lwwResolver({ decrypt })
    // Decoy ids everywhere a wrong source could read one: a top-level `id` on
    // each envelope, and a stale `id` inside each decrypted payload. The two
    // rows carry distinct ids, so reading one side's id for the other fails
    // too.
    const primary = row(
      { updatedAt: 'T2', writerId: 'dB' },
      { counter: 2, id: 'row-primary' }
    )
    primary.data = {
      id: 'envelope-decoy-primary',
      jwe: { updatedAt: 'T2', writerId: 'dB', id: 'body-decoy' }
    }
    const local = row({ updatedAt: 'T1', writerId: 'dA' }, { id: 'row-local' })
    local.data = {
      id: 'envelope-decoy-local',
      jwe: { updatedAt: 'T1', writerId: 'dA', id: 'body-decoy' }
    }

    await resolve({ realMasterState: primary, newDocumentState: local })

    expect(decryptCalls).toHaveLength(2)
    // Each call pairs a row's own id with that same row's envelope.
    expect(
      new Map(decryptCalls.map(call => [call.id, call.envelope]))
    ).toStrictEqual(
      new Map([
        ['row-primary', primary.data],
        ['row-local', local.data]
      ])
    )
    // was-client resolves a Blob only for a chunked envelope read WITH the
    // context that fetches the chunks, so passing none is what keeps a body
    // the LWW rules cannot compare out of reach.
    expect(decryptCalls.map(call => call.context)).toEqual([
      undefined,
      undefined
    ])
  })

  it('throws on an integrity failure rather than picking a winner', async () => {
    // A body written for a different resource is not an absent key. Scoring it
    // `undecryptable` would adopt or re-assert a tampered envelope with
    // nothing louder than a warn, so it leaves the resolver as a throw.
    const resolve = lwwResolver({ decrypt })
    await expect(
      resolve({
        realMasterState: markerRow(TAMPERED),
        newDocumentState: row({ updatedAt: 'T1', writerId: 'dA' })
      })
    ).rejects.toThrow(/was not written for resource/)
    expect(logged('warn')).toHaveLength(0)
  })

  it('fails the replication cycle on an integrity failure, logged at error', async () => {
    // Through the handler: makeConflictHandler's throw contract logs the row
    // and rethrows, which RxDB treats as a fatal replication error.
    await expect(
      handler.resolve({
        realMasterState: row(
          { updatedAt: 'T2', writerId: 'dB' },
          { counter: 2 }
        ),
        newDocumentState: markerRow(TAMPERED)
      })
    ).rejects.toThrow(/was not written for resource/)
    expect(logged('error')).toHaveLength(1)
    expect(logged('error')[0]?.data).toMatchObject({ id: 'r1' })
  })

  it('leaves the no-key classes in the undecryptable bucket', async () => {
    // The mirror of the integrity case: a key this reader was never given is
    // still presumed newer and still only warns.
    const primary = markerRow(UNWRAPPABLE)
    const winner = await handler.resolve({
      realMasterState: primary,
      newDocumentState: row({
        updatedAt: '2026-01-01T00:00:00Z',
        writerId: 'dA'
      })
    })
    expect(winner).toBe(primary)
    expect(logged('error')).toHaveLength(0)
    expect(logged('warn')).toHaveLength(1)
    expect(logged('warn')[0]?.data).toMatchObject({ reason: 'key-unwrap' })
  })

  it('scores a Blob body undecryptable rather than absent', async () => {
    // Unreachable through was-client's own ciphers here (no context is
    // passed), so this pins the behavior of a closure that returns one anyway:
    // a body whose stamp cannot be read is something this client cannot
    // compare, not nothing to compare.
    const resolve = lwwResolver({
      decrypt: async () => new Blob(['chunked'])
    })
    const primary = markerRow('anything')
    await expect(
      resolve({
        realMasterState: primary,
        newDocumentState: row({ updatedAt: 'T9', writerId: 'dA' })
      })
    ).resolves.toBe('remote')
    expect(logged('warn')).toHaveLength(1)
    expect(logged('warn')[0]?.data).toMatchObject({ reason: 'other' })
  })
})

describe('lwwResolver undecryptable warnings', () => {
  it('warns through the seam at warn, with nothing at error or on the console', async () => {
    // Through the packaged handler, so the wrapper's error path is covered
    // too: it logs only for a resolver that throws.
    const consoleSpies = (
      ['debug', 'info', 'log', 'warn', 'error'] as const
    ).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    try {
      const primary = sealedRow()
      await expect(
        handler.resolve({
          realMasterState: primary,
          newDocumentState: row({ updatedAt: 'T1', writerId: 'dA' })
        })
      ).resolves.toBe(primary)
      expect(logged('warn')).toHaveLength(1)
      expect(logged('warn')[0]?.msg).toContain('did not decrypt')
      expect(logged('error')).toEqual([])
      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled()
      }
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore()
      }
    }
  })
})
