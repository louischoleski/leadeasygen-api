import 'dotenv/config'
import { defineConfig } from '@playwright/test'

/**
 * API-level e2e config. These specs hit the running API directly (Playwright's
 * `request` fixture — no browser), so the api must already be up and its
 * DATABASE_URL reachable. See tests/e2e/README.md.
 */
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: API_URL,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  },
})
