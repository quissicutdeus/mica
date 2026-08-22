import { defineConfig, devices } from '@playwright/test';

/**
 * 4173 — vite preview's port, deliberately NOT the dev server's 5173.
 *
 * The suite serves a built bundle now (see `webServer` below), and keeping it off the dev
 * port means a `pnpm dev` a developer has open is never mistaken for it. Before, they
 * shared 5173 and `reuseExistingServer` would silently hand the whole run to whatever
 * happened to be listening.
 */
const PORT = process.env.E2E_PORT || 4173;

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
    /**
     * A built bundle, not `pnpm dev`.
     *
     * Vite's dev server transforms modules on demand. With more than one worker that is a
     * compile stampede: every worker asks for a cold module graph at once and each request
     * queues behind the others, so specs time out over compilation rather than over
     * anything they assert. It was the dominant cause of 20 of the 22 failures a
     * multi-worker local run produced (MICA-36), none of which reproduced serially.
     *
     * Building first moves that work to one deterministic step before any worker starts,
     * and `scripts/verify.js` no longer needs the `warmServer()` browser-navigation hack
     * that existed solely to force compilation up front.
     *
     * `--mode development` and not a plain production build: `window.triggerTestToast` and
     * `window.appRegistryStore` live behind `import.meta.env.DEV` in `shell/devHarness.ts`,
     * and `keybinds.spec.ts` and `error_boundary.spec.ts` drive both. A production bundle
     * drops them and those specs fail on a global that is simply not there. Mode keeps the
     * semantics identical to the dev server while still producing static output.
     */
    command: `pnpm build:e2e && pnpm preview --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    /**
     * Safe to reuse now, and no longer load-bearing.
     *
     * It used to be `true` because `scripts/verify.js` started the dev server itself and
     * Playwright had to accept it — with `!process.env.CI` every CI run failed at the e2e
     * gate while the identical command passed locally. verify.js no longer starts
     * anything, so this only ever finds a preview server left over from a previous run on
     * a port nothing else uses.
     */
    reuseExistingServer: true,
    /** A cold build (add-ons, then the shell) rather than just a server boot. */
    timeout: 180 * 1000
  }
});
