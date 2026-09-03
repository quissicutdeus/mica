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

/**
 * The specs that assert on the colour scheme, and so are the only ones worth running in
 * both of them.
 *
 * A named list rather than a naming convention, because it is checked:
 * `src/lib/e2eThemeCoverage.test.ts` reads this file and fails if any spec outside the
 * list reads a computed colour. That guard is what makes the single-scheme default below
 * safe — without it, adding a colour assertion to an untagged spec would quietly leave it
 * exercised in one scheme only, which is the gap the old two-project matrix closed by
 * brute force. Keep the entries as plain single-quoted globs, one per line.
 */
const THEME_SPECS = [
  '**/theme-modes.spec.ts',
  '**/settings-persistence.spec.ts',
  '**/a11y.spec.ts',
  // The album-art tint on the now-playing card (MICA-111) reads a `--color-*` value back
  // out of the DOM. It is a spec of its own rather than a test inside `music.spec.ts` for
  // exactly this reason: every entry here runs a whole file twice.
  //
  // (No apostrophes in this comment, deliberately. `lib/e2eThemeCoverage.test.ts` reads
  // this array out of the file with a naive single-quote scan, so one would look like the
  // start of a glob and swallow the entry below it.)
  '**/music-artwork.spec.ts'
];

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
    viewport: { width: 1280, height: 960 },
    /**
     * MICA-70's first-run privacy notice defaults `privacyNoticeSeen` to `false`, and
     * `PhoneFrame.svelte` renders it as a `z-[9999]` scrim above everything else in the
     * phone the moment that's true — which every spec here now is, since none of them have
     * ever seen it. Left unseeded, it intercepts the very first click of nearly the entire
     * suite (visible as `locator.click: ... intercepts pointer events` against the scrim,
     * not against whatever the test actually meant to click), so this is not a per-spec
     * concern to dismiss — it is seeded true for the whole suite, the same way the theme
     * key is seeded below for `chromium-light`. A spec that wants to test the notice
     * itself overrides this with its own `storageState`/`addInitScript`, same as any other
     * persisted default a test needs to defeat.
     */
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${PORT}`,
          localStorage: [{ name: 'gos:settings:privacyNoticeSeen', value: 'true' }]
        }
      ]
    }
  },
  projects: [
    /**
     * CEF floor: Chromium 103 (2022 branch point).
     *
     * Runs only when CEF_FLOOR_CHROMIUM environment variable points to a Chromium 103
     * executable. When not set, prints a message and skips without reporting as passed.
     * This is intentionally loud, never silent — a gate that stays quiet when it cannot
     * run reads as a pass.
     *
     * Download Chromium r1002910 (Linux_x64) from chromium-browser-snapshots to test
     * this project. The executable is typically at <unzipped>/chrome-linux/chrome.
     *
     *   export CEF_FLOOR_CHROMIUM=/path/to/chrome-linux/chrome
     *   pnpm test:e2e
     */
    ...(process.env.CEF_FLOOR_CHROMIUM
      ? [
          {
            name: 'cef-floor',
            use: {
              ...devices['Desktop Chrome'],
              viewport: { width: 1280, height: 960 },
              launchOptions: {
                executablePath: process.env.CEF_FLOOR_CHROMIUM
              }
            }
          }
        ]
      : (() => {
          if (process.env.CI) {
            throw new Error(
              'CEF_FLOOR_CHROMIUM is not set. CI must provide the Chromium 103 binary path. ' +
                'The cef-floor project is not optional in CI.'
            );
          }
          // In local runs, print a message that this project is being skipped, never silent.
          console.log(
            '\n[cef-floor] Skipped: CEF_FLOOR_CHROMIUM not set. ' +
              'To test Chromium 103 compatibility, download r1002910 and set: ' +
              'export CEF_FLOOR_CHROMIUM=/path/to/chrome-linux/chrome\n'
          );
          return [];
        })()),
    /**
     * Every spec, in the default scheme.
     *
     * The suite used to run twice over — once dark, once light — for roughly double the
     * wall time. Light mode is genuinely not a skin over dark (the roles invert, so
     * `on-surface` moves from near-white to near-black and every surface tier with it),
     * but nothing here compares pixels: these specs assert on the DOM and on geometry,
     * both of which are identical between schemes. Twenty-seven of the twenty-nine spec
     * files were asserting the same things a second time.
     */
    {
      name: 'chromium',
      // The tablet specs run under their own project below, on a window that fits the
      // frame; here they would only ever see it size-limited.
      testIgnore: /tablet\//,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 960 } }
    },
    /**
     * The tablet (MICA-261): every spec under `e2e/tablet/`, on a window with room for
     * the 1280x800 frame and its margins (1312x832 is the floor; 1440x1000 leaves some
     * zoom either way). The privacy seed is repeated for the reason `chromium-light`
     * repeats it: a project-level `storageState` replaces the top-level one.
     */
    {
      name: 'tablet',
      testMatch: /tablet\//,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
        storageState: {
          cookies: [],
          origins: [
            {
              origin: `http://127.0.0.1:${PORT}`,
              localStorage: [{ name: 'gos:settings:privacyNoticeSeen', value: 'true' }]
            }
          ]
        }
      }
    },
    /**
     * The colour-asserting specs again, in light.
     *
     * The mode is seeded through `localStorage` before the app boots rather than by driving
     * the Settings UI, because a spec about Messages should not have to walk through Display
     * to get there. `usePersisted` reads its key once at construction, in module scope, so
     * the value has to be present before the bundle evaluates — an `addInitScript` after
     * navigation would be too late.
     */
    {
      name: 'chromium-light',
      testMatch: THEME_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 960 },
        // A project-level `storageState` fully replaces the top-level one rather than
        // merging with it, so the privacy-notice seed above has to be repeated here too —
        // otherwise this project's own specs would hit the exact scrim-intercepts-clicks
        // failure the top-level seed exists to prevent.
        storageState: {
          cookies: [],
          origins: [
            {
              origin: `http://127.0.0.1:${PORT}`,
              localStorage: [
                {
                  name: 'gos:settings:theme',
                  value: JSON.stringify({ seed: '#155dfc', mode: 'light' })
                },
                { name: 'gos:settings:privacyNoticeSeen', value: 'true' }
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
