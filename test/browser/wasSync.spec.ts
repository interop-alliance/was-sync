import { test, expect } from '@playwright/test'

test('the root entry loads and works in a real browser, with no rxdb', async ({
  page
}) => {
  await page.goto('/test/index.html')

  // The dev server answers every `rxdb` import with a module that throws, so a
  // module that imports it fails to load. Without this the claim below would
  // be vacuous, since `rxdb` is installed as a devDependency.
  const probe = await page.evaluate(async () => {
    try {
      // @ts-expect-error -- dev-server URL, resolved at runtime by vite
      await import('/test/browser/rxdbProbe.ts')
      return 'loaded'
    } catch (err) {
      return (err as Error).message
    }
  })
  expect(probe).toContain('rxdb is not installed: rxdb/plugins/core')

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

    const decrypt = async ({ envelope }: { id: string; envelope: unknown }) =>
      (envelope as { jwe: unknown }).jwe
    const handler = makeLwwConflictHandler(decrypt)
    const stamped = (updatedAt: string, version: number) => ({
      id: 'r1',
      updatedAt: '2026-01-01T00:00:00Z',
      version,
      _deleted: false,
      data: { jwe: { updatedAt, writerId: 'w1' } }
    })
    // Each direction once, so neither RxDB's remote-wins default nor a
    // local-wins rule would pass both.
    const remoteLater = await handler.resolve({
      realMasterState: stamped('2026-02-02T00:00:00Z', 2),
      newDocumentState: stamped('2026-01-01T00:00:00Z', 1)
    })
    const localLater = await handler.resolve({
      realMasterState: stamped('2026-01-01T00:00:00Z', 2),
      newDocumentState: stamped('2026-02-02T00:00:00Z', 1)
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
      laterRemotePayloadWins: remoteLater.version === 2,
      laterLocalPayloadWins: localLater.version === 1,
      writerIdStable: writerId === again && writerId.length > 0,
      writerIdCleared: localStorage.getItem('was-sync-smoke:writerId') === null
    }
  })
  expect(result).toEqual({
    schemaVersion: 0,
    keyOrderEqual: true,
    laterRemotePayloadWins: true,
    laterLocalPayloadWins: true,
    writerIdStable: true,
    writerIdCleared: true
  })
})
