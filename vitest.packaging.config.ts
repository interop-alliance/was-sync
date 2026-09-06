import { defineConfig } from 'vitest/config'

/**
 * The packaging suite (`pnpm run test:packaging`), run after `pnpm run build`.
 * It asserts over `dist/` rather than `src/`, which the ordinary vitest config
 * deliberately excludes.
 */
export default defineConfig({
  test: {
    include: ['test/packaging/**/*.test.ts']
  }
})
