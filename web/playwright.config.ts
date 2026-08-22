import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PORT || 5173;

export default defineConfig({
  testDir: './e2e',
  /**
   * Ten seconds per test, not Playwright's thirty. Every test here that is going to pass
   * does so in under ten; the only ones that ever reached thirty were the home-grid drag
   * flakes, which sit on the limit and then fail anyway. Twenty seconds of waiting per
   * flake, times six, times two projects, is four minutes of a verify run spent on nothing.
   */
  timeout: 10_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html']] : [['list'], ['html', { open: 'on-failure' }]],
  use: {
    headless: !process.env.HEADED,
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 960 }
  },
  /**
   * The whole suite runs in both color schemes.
   *
   * Light mode is not a skin over dark — the roles invert, so `on-surface` goes from a
   * near-white to a near-black and every surface tier moves with it. Nothing had ever
   * rendered light until the Display toggle shipped, which means every screen in the phone
   * was unexercised in half its supported states.
   *
   * The mode is seeded through `localStorage` before the app boots rather than by driving
   * the Settings UI, because a spec about Messages should not have to walk through Display
   * to get there. `usePersisted` reads its key once at construction, in module scope, so
   * the value has to be present before the bundle evaluates — an `addInitScript` after
   * navigation would be too late.
   *
   * The cost is roughly double the wall time. That is the price of the second scheme
   * actually being supported rather than merely available.
   */
  projects: [
    {
      name: 'chromium-dark',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 960 } }
    },
    {
      name: 'chromium-light',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 960 },
        storageState: {
          cookies: [],
          origins: [
            {
              origin: `http://127.0.0.1:${PORT}`,
              localStorage: [
                {
                  name: 'gphone:settings:theme',
                  value: JSON.stringify({ seed: '#155dfc', mode: 'light' })
                }
              ]
            }
          ]
        }
      }
    }
  ],
  webServer: {
    command: 'pnpm dev',
    url: `http://127.0.0.1:${PORT}`,
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
