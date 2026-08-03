import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PORT || 5173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html']] : [['list'], ['html', { open: 'on-failure' }]],
  use: {
    headless: !process.env.HEADED,
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 960 }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 960 }
      }
    }
  ],
  webServer: {
    command: 'pnpm dev',
    url: `http://localhost:${PORT}`,
    /**
     * Always reuse, including in CI.
     *
     * The usual reason to refuse in CI is that a leftover server would serve stale code —
     * but nothing here is left over. `scripts/verify.js` starts one Vite server up front
     * and runs the whole e2e suite against it, precisely because Playwright's own cold
     * start costs about two and a half minutes against twenty-seven seconds warm.
     *
     * With `!process.env.CI` that arrangement could not work: `verify` started the server,
     * then Playwright found the port occupied and refused it, so **every CI run failed at
     * the e2e gate** while the identical command passed locally. Each CI job is a fresh
     * container, so there is no stale server for the strict setting to protect against.
     */
    reuseExistingServer: true,
    timeout: 120 * 1000
  }
});
