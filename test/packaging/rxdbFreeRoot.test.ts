/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The packaging suite: it asserts over `dist/` and so runs after
 * `pnpm run build` (`pnpm run test:packaging`).
 *
 * The root entry's RxDB-freedom is a packaging contract rather than a style
 * preference. A consumer that reads shared collections without ever building a
 * replica must resolve `@interop/was-sync` with `rxdb` absent, and a missing
 * package is a module-resolution failure rather than something a bundler drops.
 * The declarations matter as much as the runtime graph: every consumer compiles
 * with `skipLibCheck`, so an `import type ... from 'rxdb/plugins/core'`
 * surviving in `dist/index.d.ts` would degrade to a silent error type rather
 * than failing loudly.
 *
 * The check walks the emitted module graph from each entry, following relative
 * imports and collecting the bare specifiers, so it holds however the modules
 * are arranged behind the entry.
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist')

/**
 * Every specifier a file imports or re-exports, relative and bare alike.
 *
 * @param source {string}
 * @returns {string[]}
 */
function specifiersOf(source: string): string[] {
  const found: string[] = []
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  let match = pattern.exec(source)
  while (match !== null) {
    if (match[1] !== undefined) {
      found.push(match[1])
    }
    match = pattern.exec(source)
  }
  return found
}

/**
 * Walks the emitted graph from one entry file, returning every bare (package)
 * specifier it reaches through relative imports.
 *
 * @param entry {string}   a file name under `dist`
 * @returns {Promise<Set<string>>}
 */
async function bareSpecifiersFrom(entry: string): Promise<Set<string>> {
  const bare = new Set<string>()
  const seen = new Set<string>()
  const queue = [resolve(DIST, entry)]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    const source = await readFile(file, 'utf8')
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        queue.push(
          file.endsWith('.d.ts') ? target.replace(/\.js$/, '.d.ts') : target
        )
      } else {
        bare.add(specifier)
      }
    }
  }
  return bare
}

describe('the root entry is free of rxdb', () => {
  it('reaches no rxdb module at runtime', async () => {
    const bare = await bareSpecifiersFrom('index.js')
    expect([...bare].filter(name => name.startsWith('rxdb'))).toEqual([])
    // The was-client peer is reached at runtime only through its `/sync`
    // subpath, for the `err.name` predicates the conflict handler classifies
    // with; the root package itself is types-only. social-core and the two
    // small utilities are the whole of the rest.
    expect([...bare].sort()).toEqual([
      '@interop/social-core',
      '@interop/was-client/sync',
      'json-canonicalize',
      'uuidv7'
    ])
  })

  it('names no rxdb module in its declarations', async () => {
    const bare = await bareSpecifiersFrom('index.d.ts')
    expect([...bare].filter(name => name.startsWith('rxdb'))).toEqual([])
  })

  it('loads with no rxdb resolvable', async () => {
    const root = await import('../../dist/index.js')
    expect(typeof root.syncedDocSchema).toBe('function')
    expect(root.syncedDocSchema().version).toBe(0)
  })
})

describe('the rxdb entry carries the peer', () => {
  it('imports rxdb, which is exactly why it is a separate subpath', async () => {
    const bare = await bareSpecifiersFrom('rxdb.js')
    expect([...bare].filter(name => name.startsWith('rxdb')).sort()).toEqual([
      'rxdb/plugins/replication'
    ])
  })

  it('declares rxdb types', async () => {
    const bare = await bareSpecifiersFrom('rxdb.d.ts')
    expect(
      [...bare].filter(name => name.startsWith('rxdb')).length
    ).toBeGreaterThan(0)
  })
})

describe('the testing entry', () => {
  it('needs no rxdb either, so a consumer fake costs no replica', async () => {
    const bare = await bareSpecifiersFrom('testing.js')
    expect([...bare].filter(name => name.startsWith('rxdb'))).toEqual([])
  })
})
