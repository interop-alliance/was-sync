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
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist')

/**
 * Every specifier a file imports or re-exports, relative and bare alike, plus
 * every package a `/// <reference types="..." />` directive names.
 *
 * @param source {string}
 * @returns {string[]}
 */
function specifiersOf(source: string): string[] {
  const found: string[] = []
  const pattern =
    /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|\/\/\/\s*<reference\s+types\s*=\s*['"]([^'"]+)['"]/g
  let match = pattern.exec(source)
  while (match !== null) {
    const specifier = match[1] ?? match[2]
    if (specifier !== undefined) {
      found.push(specifier)
    }
    match = pattern.exec(source)
  }
  return found
}

/**
 * Imports one emitted entry in a child `node` process whose module resolver
 * refuses `rxdb` and every `rxdb/*` subpath, as if the package were not
 * installed, and returns what the child printed: the synced-document schema
 * version when the entry loads, or the error message when it does not.
 *
 * @param entry {string}   a file name under `dist`
 * @returns {string}
 */
function importWithRxdbUnresolvable(entry: string): string {
  const script = `
    import { registerHooks } from 'node:module'
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (/^rxdb(\\/|$)/.test(specifier)) {
          const err = new Error('rxdb is not installed: ' + specifier)
          err.code = 'ERR_MODULE_NOT_FOUND'
          throw err
        }
        return nextResolve(specifier, context)
      }
    })
    try {
      const entry = await import(${JSON.stringify(pathToFileURL(resolve(DIST, entry)).href)})
      console.log(String(entry.syncedDocSchema().version))
    } catch (err) {
      console.log(err.message)
    }
  `
  return execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8' }
  ).trim()
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

  it('loads with no rxdb resolvable', () => {
    expect(importWithRxdbUnresolvable('index.js')).toBe('0')
  })
})

describe('the rxdb entry carries the peer', () => {
  it('imports rxdb, which is exactly why it is a separate subpath', async () => {
    const bare = await bareSpecifiersFrom('rxdb.js')
    expect([...bare].filter(name => name.startsWith('rxdb')).sort()).toEqual([
      'rxdb/plugins/replication'
    ])
  })

  it('fails to load with no rxdb resolvable, so the root check is not vacuous', () => {
    expect(importWithRxdbUnresolvable('rxdb.js')).toBe(
      'rxdb is not installed: rxdb/plugins/replication'
    )
  })

  it('declares rxdb types', async () => {
    const bare = await bareSpecifiersFrom('rxdb.d.ts')
    expect(
      [...bare].filter(name => name.startsWith('rxdb')).length
    ).toBeGreaterThan(0)
  })
})

describe('the testing entry', () => {
  it('needs no rxdb in its runtime graph, so a consumer fake costs no replica', async () => {
    const bare = await bareSpecifiersFrom('testing.js')
    expect([...bare].filter(name => name.startsWith('rxdb'))).toEqual([])
  })
})
