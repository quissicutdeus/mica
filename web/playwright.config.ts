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
  // MICA-39: wipe test-results/ before any run — whole suite or one filtered spec —
  // so a stale failure directory from an earlier run is never mistaken for this one.
  globalSetup: './e2e/support/globalSetup.ts',
  /**
   * Playwright's default thirty, after ten was measured wrong.
   *
   * Ten was chosen on the reasoning that "every test here that is going to pass does so in
   * under ten", and that anything reaching thirty was a flake sitting on the limit and
   * failing anyway — so the extra twenty seconds were pure waiting. That was true when it
   * was written, and it was measured serially.
   *
   * Under four workers it is false. A run at that width produced five failures whose
   * durations were 10.3s, 10.4s, 10.5s, 11.1s, 11.3s and 11.7s — every one of them within
   * two seconds of the line, none hanging, none asserting anything false, and each passing
   * comfortably on a run where it happened to get a quieter slice of CPU. They were not
   * flakes sitting on the limit; the limit was sitting on them.
   *
   * The cost the old number was avoiding is smaller than it looks now: `retries` is 0, so a
   * genuinely failing test is waited out once rather than three times, and the count of
   * tests that can reach the ceiling at all is the short list above.
   */
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  /**
   * No retries, anywhere.
   *
   * CI used to retry twice, so "passes in CI" meant *passes with up to three attempts* —
   * and because CI was also the only place that ran serially, a test could be reliably
   * broken under parallelism and still show green on every PR. The two settings hid each
   * other. A retry here now means a flake nobody is being told about, which is the state
   * this ticket existed to leave.
   */
  retries: 0,
  /**
   * Whatever the machine has, on CI as well as locally.
   *
   * CI pinned this to 1 while local ran ~4, so the suite was never actually exercised
   * under parallelism by anything that gates a merge — the failures only ever appeared on
   * a developer's machine, which is precisely backwards. `undefined` lets Playwright size
   * the pool; the reason it is safe now is that the suite serves a built bundle rather
   * than compiling on demand under every worker (see `webServer`).
   */
  workers: undefined,
  reporter: process.env.CI ? [['github'], ['html']] : [['list'], ['html', { open: 'on-failure' }]],
  use: {
    headless: !process.env.HEADED,
    baseURL: `http://127.0.0.1:${PORT}`,
    // No retries to be the 'first' of, so capture on the failure itself.
    trace: 'retain-on-failure',
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
     * Never reuse. The command below *builds* before it serves, and reuse skips the whole
     * command — so a preview server left listening from an earlier run makes the suite
     * silently test the previous bundle. That is exactly what happened while fixing
     * MICA-36: a spec was "still failing" against code that had already been changed,
     * because the server answering on this port had been built ten minutes earlier.
     *
     * With `--strictPort`, a leftover server is now a loud bind failure instead of a
     * quiet wrong answer. It used to be `true` because `scripts/verify.js` started the
     * dev server itself and Playwright had to accept it; verify.js no longer starts
     * anything.
     */
    reuseExistingServer: false,
    /** A cold build (add-ons, then the shell) rather than just a server boot. */
    timeout: 180 * 1000
  }
});
