import { defineConfig, devices } from '@playwright/test'
import { SMOKE_PORT } from './vite.config.js'

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: `http://localhost:${SMOKE_PORT}`,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'pnpm run dev',
    url: `http://localhost:${SMOKE_PORT}/test/index.html`,
    env: { WAS_SYNC_BROWSER_SMOKE: '1' },
    reuseExistingServer: !process.env.CI
  }
})
