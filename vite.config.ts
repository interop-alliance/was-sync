import { defineConfig } from 'vitest/config'

/**
 * The port the Playwright smoke test's dev server listens on. It is a
 * dedicated, uncommon one, so a dev server some other checkout left running
 * on Vite's default port is never picked up in its place.
 */
export const SMOKE_PORT = 5791

/**
 * Set by Playwright's `webServer` only. The smoke test loads the root entry,
 * which must run with `rxdb` absent, so under this flag the dev server
 * resolves every `rxdb` and `rxdb/*` import to a module that throws when
 * evaluated. Vitest never sets it, and the node suites import `rxdb` freely.
 */
const SMOKE = process.env.WAS_SYNC_BROWSER_SMOKE === '1'

const BLOCKED_PREFIX = '\0rxdb-unavailable:'

/**
 * A resolver that answers every `rxdb` specifier with a module that throws, as
 * if the package were not installed. It is installed for the app graph and
 * for dependency pre-bundling alike, so a dependency importing `rxdb` is
 * caught as well as a source module.
 *
 * @returns {object}
 */
function refuseRxdb() {
  return {
    name: 'was-sync:refuse-rxdb',
    enforce: 'pre' as const,
    resolveId(source: string) {
      return /^rxdb(\/|$)/.test(source) ? BLOCKED_PREFIX + source : null
    },
    load(id: string) {
      if (!id.startsWith(BLOCKED_PREFIX)) {
        return null
      }
      const specifier = id.slice(BLOCKED_PREFIX.length)
      return `throw new Error(${JSON.stringify(`rxdb is not installed: ${specifier}`)})`
    }
  }
}

export default defineConfig({
  ...(SMOKE && {
    plugins: [refuseRxdb()],
    optimizeDeps: { rolldownOptions: { plugins: [refuseRxdb()] } }
  }),
  server: { port: SMOKE_PORT, strictPort: true },
  test: {
    include: ['test/node/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts']
    }
  }
})
