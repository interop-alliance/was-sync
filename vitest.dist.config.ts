import { defineConfig } from 'vitest/config'

/**
 * The built-output suite (`pnpm run test:dist`), run after `pnpm run build`.
 * It asserts over `dist/` rather than `src/`, which the ordinary vitest config
 * deliberately excludes.
 */
export default defineConfig({
  test: {
    include: ['test/dist/**/*.test.ts']
  }
})
