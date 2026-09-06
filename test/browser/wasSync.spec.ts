import { test, expect } from '@playwright/test'

test('the root entry loads and works in a real browser, with no rxdb', async ({
  page
}) => {
  await page.goto('/test/index.html')
  const result = await page.evaluate(async () => {
    // This callback runs in the browser; the path is a URL served by the vite
    // dev server, not a module path tsc can resolve from disk. Only the ROOT
    // entry is exercised: it is the one a consumer must be able to load
    // without RxDB, and loading it here proves its dependencies (the JCS
    // canonicalizer, the uuid mint, the LWW comparator) work under the browser
    // build.
    // @ts-expect-error -- dev-server URL, resolved at runtime by vite
    const mod = await import('/src/index.ts')
    const {
      bodiesEqual,
      getWriterId,
      clearPersistedWriterId,
      makeLwwConflictHandler,
      syncedDocSchema
    } = mod

    const decrypt = async (envelope: { jwe: unknown }) => envelope.jwe
    const handler = makeLwwConflictHandler(decrypt)
    const stamped = (updatedAt: string, version: number) => ({
      id: 'r1',
      updatedAt: '2026-01-01T00:00:00Z',
      version,
      _deleted: false,
      data: { jwe: { updatedAt, writerId: 'w1' } }
    })
    const remote = stamped('2026-02-02T00:00:00Z', 2)
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: stamped('2026-01-01T00:00:00Z', 1)
    })

    const writerId = getWriterId({
      storageKeyPrefix: 'was-sync-smoke:',
      storage: localStorage
    })
    const again = getWriterId({
      storageKeyPrefix: 'was-sync-smoke:',
      storage: localStorage
    })
    clearPersistedWriterId({
      storageKeyPrefix: 'was-sync-smoke:',
      storage: localStorage
    })

    return {
      schemaVersion: syncedDocSchema().version,
      keyOrderEqual: bodiesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }),
      laterPayloadWins: winner.version === 2,
      writerIdStable: writerId === again && writerId.length > 0,
      writerIdCleared: localStorage.getItem('was-sync-smoke:writerId') === null
    }
  })
  expect(result).toEqual({
    schemaVersion: 0,
    keyOrderEqual: true,
    laterPayloadWins: true,
    writerIdStable: true,
    writerIdCleared: true
  })
})
