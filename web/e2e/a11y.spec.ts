import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type FrameLocator, type Locator, type Page } from './support/test';
import AxeBuilder from '@axe-core/playwright';
import type { AxeResults, Result } from 'axe-core';
import { addOnFrame } from './support/addon';
import { openAppDrawer, seedHomeGrid } from './support/homeGrid';
import { settlePhoneOpen } from './support/phoneOpen';
import { wallpaperImage } from '@mica/shared/imageSource';
import { blurred, seedStreamerMode } from './support/streamerMode';

/**
 * The accessibility gate (MICA-109 item 3).
 *
 * MICA-66 landed reduced motion, focus trapping and a live region, and MICA-109 landed
 * the focus ring and a set of contrast fixes. Both are conventions, and every unenforced
 * convention in this repo has rotted — which is why the ticket called this one "what keeps
 * the rest true" and why it was written before the fixes rather than after: the failures
 * arrive as a red run instead of as a list somebody has to compile by hand.
 *
 * ## What this covers
 *
 * axe-core's full default rule set, over the phone frame, on every app and on the shell
 * surfaces an app never reaches (home, drawer, shade). Contrast is the rule that matters
 * most here and it is measured on the *rendered* page, so it accounts for the composited
 * state-layer tokens and for whatever seed and scheme are in play — which is exactly what
 * a static reading of `app-utilities.css` cannot do.
 *
 * The app list is read off `src/apps/` rather than written out, so an app added tomorrow is
 * swept tomorrow. That is the difference between a gate and a snapshot.
 *
 * ## What it cannot cover, and why the two hand-written checks below exist
 *
 * - **Focus indicators.** axe has no rule for whether a focus ring is *visible* — it can
 *   see that an element is focusable, not that you can tell. `the focus ring is visible on
 *   every shell surface` below measures the computed outline instead.
 * - **Text over a wallpaper.** axe returns `incomplete`, not a violation, whenever it
 *   cannot resolve a background — "contains an image node", "due to a background gradient".
 *   Every wallpaper is one or the other, so the home screen's labels, clock and heading are
 *   precisely the pixels axe declines to judge, and they are the ones MICA-109 was opened
 *   about. `the wallpaper treatment...` below measures the stroke that makes the question
 *   answerable at all.
 * - **Short text.** axe skips a node whose content is "too short to determine if it is
 *   actual text content", which is how a `1` in an unread badge at 1.31:1 and a `=` key at
 *   the same ratio both sat in `incomplete` rather than in `violations`. Both were found by
 *   reading `bg-<role>` call sites against their `text-` class and both are fixed; a future
 *   one will not be caught here.
 * - **CEF.** Playwright drives a modern Chromium (AGENTS.md §6). A green run says nothing
 *   about Chromium 103.
 *
 * ## What is switched off
 *
 * Rules that cannot apply here (`NOT_APPLICABLE`) and defects this gate found and did not
 * fix (`KNOWN_OPEN`) — both lists are below, each entry with its reason, and they are the
 * whole of it. Nothing else: a new axe rule arrives here as a failure, which is the point.
 */

const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Every app, and whether it renders into an iframe.
 *
 * Read from the manifest source rather than imported: this file runs in Node under
 * Playwright, and a manifest pulls in `defineApp`, the SDK, and the app's icon component
 * behind it. The regex only has to answer one question and `appContract.test.ts` already
 * fails if a manifest omits `core` (AGENTS.md §11).
 */
const APPS: { id: string; addOn: boolean }[] = fs
  .readdirSync(path.join(WEB, 'src/apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const manifest = fs.readFileSync(path.join(WEB, 'src/apps', entry.name, 'manifest.ts'), 'utf8');
    const core = /^\s*core:\s*(true|false)\s*,?\s*$/m.exec(manifest);
    if (!core) throw new Error(`${entry.name}/manifest.ts declares no \`core\``);
    return { id: entry.name, addOn: core[1] === 'false' };
  });

/** `#rrggbb`/`rgb(...)` to the WCAG relative luminance. */
const luminance = (css: string): number => {
  const [r, g, b] = css
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** WCAG 2.x contrast ratio, 1..21. */
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every violation, as `rule (impact) xN — first failure` lines, for a readable assertion. */
const summarise = (results: AxeResults): string[] =>
  results.violations.map(
    (v: Result) =>
      `${v.id} (${v.impact}) x${v.nodes.length} — ${v.nodes[0].failureSummary?.split('\n').slice(1).join(' ').trim()}` +
      `\n      at ${String(v.nodes[0].target)}`
  );

/**
 * Rules disabled everywhere, and why.
 *
 * `region` and `landmark-one-main` are document-structure rules — every node should sit in
 * a landmark, a document should have one `<main>`. A `core: false` add-on renders into a
 * sandboxed `srcdoc` iframe, so each one *is* a document by construction and fires both,
 * always, for every add-on in the tree. Satisfying them would mean a `<main>` inside each
 * 400x850 pane: landmark structure invented to satisfy a scanner rather than to help
 * anyone, on a phone that shows one screen at a time.
 */
const NOT_APPLICABLE = ['region', 'landmark-one-main'];

/**
 * Defects this gate found, has not fixed, and refuses to hide.
 *
 * The alternative to naming them here was landing a red gate, and a gate that is red on
 * arrival is one nobody reads by the second week. The alternative to *that* was quietly
 * dropping the surface from the sweep, which is the failure-open shape AGENTS.md warns
 * about — an excluded screen looks exactly like a clean one.
 *
 * So each entry is one rule, on one surface, with the measurement and the reason it is
 * somebody's decision rather than a mechanical fix. Anything else on that surface still
 * fails. Deleting an entry is how one gets closed.
 *
 * There are none open at the moment; the mechanism stays so the next one is named here
 * rather than hidden.
 */
const KNOWN_OPEN: Record<string, string[]> = {};

const scan = (page: Page, surface: string) =>
  new AxeBuilder({ page })
    // The phone, not the dev-browser page it is previewed on. Outside the frame there is
    // only the `html[data-preview-theme]` backdrop, which ships to nobody.
    .include('[data-testid="phone-frame"]')
    .disableRules([...NOT_APPLICABLE, ...(KNOWN_OPEN[surface] ?? [])])
    .analyze();

/**
 * Open an app by deep link and wait until it has actually painted.
 *
 * `?app=` is `devHarness.ts`'s own opener and resolves a `core: false` app without going
 * through the Store, which is the only reason this file can sweep add-ons without
 * installing eight of them. The wait is the part that matters: `settlePhoneOpen` covers the
 * frame's 500ms entrance, and the second poll covers the app's own — scanning a screen
 * mid-transition measures colours that are still being composited.
 */
const openApp = async (page: Page, app: { id: string; addOn: boolean }): Promise<void> => {
  await page.goto(`/?app=${app.id}`);
  await settlePhoneOpen(page);
  if (app.addOn) {
    const frame = page.frameLocator(`iframe[data-app="${app.id}"]`);
    await expect(frame.locator('body > *').first()).toBeAttached({ timeout: 15_000 });
  }
  const frame = page.getByTestId('phone-frame');
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations({ subtree: true }).length), {
      timeout: 5000
    })
    .toBe(0);
};

for (const app of APPS) {
  test(`${app.id} has no accessibility violations`, async ({ page }) => {
    await seedHomeGrid(page, ['settings']);
    await openApp(page, app);
    const results = await scan(page, app.id);
    expect(summarise(results), `${app.id}:\n  ${summarise(results).join('\n  ')}`).toEqual([]);
  });
}

/**
 * Settings > Display (MICA-298).
 *
 * The loop above only ever opens the Settings app to its default screen — a list of rows,
 * `Display` among them. `ThemeAndWallpaper`, and with it `ColorWheelPicker`'s lightness and
 * opacity sliders, renders only once that row is tapped, so the sweep above never reached
 * it and shipped two unlabeled `<input type="range">`s (a screen reader announced only
 * "slider") until MICA-295's tablet sweep found them. This is the phone side of that fix.
 */
test('Settings > Display has no accessibility violations', async ({ page }) => {
  await seedHomeGrid(page, ['settings']);
  await page.goto('/');
  await settlePhoneOpen(page);
  await page.locator('button', { hasText: 'Settings' }).first().click();
  // By title, the same way `display.spec.ts`'s `openDisplayPane` reaches this pane —
  // MICA-267 dropped the device-specific word from the row's subtitle.
  await page.locator('button', { hasText: 'Display' }).first().click();
  await expect(page.locator('h1', { hasText: 'Display' })).toBeVisible();

  const frame = page.getByTestId('phone-frame');
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations({ subtree: true }).length), {
      timeout: 5000
    })
    .toBe(0);

  const results = await scan(page, 'settings-display');
  expect(summarise(results), `settings-display:\n  ${summarise(results).join('\n  ')}`).toEqual([]);
});

/**
 * Settings > Privacy > Your data (MICA-168).
 *
 * Two levels below the Settings list, so the sweep above never opens it. Scanned with a
 * category expanded, because the read-only textarea that holds the rows is a scrollable region and
 * axe has a rule for those (`scrollable-region-focusable`).
 */
test('Settings > Privacy > Your data has no accessibility violations', async ({ page }) => {
  await seedHomeGrid(page, ['settings']);
  await page.goto('/');
  await settlePhoneOpen(page);
  await page.locator('button', { hasText: 'Settings' }).first().click();
  await page.locator('button', { hasText: 'About' }).first().click();
  await page.locator('button', { hasText: 'Privacy' }).first().click();
  await page.locator('button', { hasText: 'Your data' }).first().click();
  await expect(page.locator('h1', { hasText: 'Your data' })).toBeVisible();

  const categories = page.getByTestId('your-data-categories');
  await expect(categories).toBeVisible();
  await categories.getByRole('button').first().click();

  const frame = page.getByTestId('phone-frame');
  await expect
    .poll(async () => frame.evaluate((el) => el.getAnimations({ subtree: true }).length), {
      timeout: 5000
    })
    .toBe(0);

  const results = await scan(page, 'settings-your-data');
  expect(summarise(results), `settings-your-data:\n  ${summarise(results).join('\n  ')}`).toEqual(
    []
  );
});

/**
 * The home screen, the app drawer and the notification shade, one scan per test: axe's cost
 * scales with the DOM and three scans in one 30s budget are what timed out under load
 * (MICA-407). The two sheets are opened through the same helpers their own specs use
 * (`home-grid.spec.ts`, `notifications.spec.ts` own the gestures); this is a scan of what
 * is on screen.
 */
const openHome = async (page: Page) => {
  await seedHomeGrid(page, ['settings', 'contacts', 'store', 'messages']);
  await page.goto('/');
  await settlePhoneOpen(page);
};

/** Contrast measured on a fading element is measured on a colour that exists for one frame. */
const settleWithin = async (sheet: Locator) =>
  expect
    .poll(async () => sheet.evaluate((el) => el.getAnimations({ subtree: true }).length), {
      timeout: 5000
    })
    .toBe(0);

test('the home screen has no accessibility violations', async ({ page }) => {
  await openHome(page);
  const home = await scan(page, 'home');
  expect(summarise(home), `home:\n  ${summarise(home).join('\n  ')}`).toEqual([]);
});

test('the app drawer has no accessibility violations', async ({ page }) => {
  await openHome(page);
  await openAppDrawer(page);
  const drawer = page.getByRole('dialog', { name: 'App Drawer' });
  await expect(drawer).toBeVisible();
  await settleWithin(drawer);
  const results = await scan(page, 'drawer');
  expect(summarise(results), `drawer:\n  ${summarise(results).join('\n  ')}`).toEqual([]);
});

test('the notification shade has no accessibility violations', async ({ page }) => {
  await openHome(page);
  await page.getByRole('button', { name: 'Open notification shade' }).click();
  const shade = page.getByRole('dialog', { name: /notification/i });
  await expect(shade).toBeVisible();
  // `toBeVisible` resolves at the *start* of the fly-in and of the status bar date's 150ms
  // fade; this scan failed one run in three on the date span before the wait went in.
  await settleWithin(shade);
  const shadeResults = await scan(page, 'shade');
  expect(summarise(shadeResults), `shade:\n  ${summarise(shadeResults).join('\n  ')}`).toEqual([]);
});

test('the notification archive has no accessibility violations', async ({ page }) => {
  await openHome(page);
  await page.getByRole('button', { name: 'Open notification shade' }).click();
  const shade = page.getByRole('dialog', { name: /notification/i });
  await expect(shade).toBeVisible();
  await settleWithin(shade);
  await page.getByRole('button', { name: 'Notification Archive' }).click();
  await settleWithin(shade);
  const results = await scan(page, 'shade archive');
  expect(summarise(results), `archive:\n  ${summarise(results).join('\n  ')}`).toEqual([]);
});

/**
 * The two Music surfaces the sweep above cannot reach (MICA-111).
 *
 * `openApp` visits every app with nothing loaded, so Music is only ever scanned as a paste
 * field over an empty state — never as a loaded player, with a now-playing card, queue rows
 * carrying artwork, and a six-button transport. And `NowPlaying` renders only
 * `{#if $musicSource}`, so the shade scan above, which runs with nothing playing, never sees
 * the one control that stops audio without opening the app. Both are the app's normal state
 * rather than an edge of it, and neither was swept.
 *
 * The embed is stubbed, not loaded. An accessibility gate must not go red because YouTube is
 * slow (`retries: 0`), and the frame's own document is outside `.include()` regardless — the
 * player is mounted outside the phone frame entirely, which is why `music.spec.ts` rather
 * than axe is what holds it out of the tab order.
 */
test.describe('Music with a track loaded', () => {
  // One scan per test (MICA-407): three scans in one 30s budget are the next timeout.
  test.beforeEach(async ({ page }) => {
    await page.route(/https:\/\/www\.youtube(-nocookie)?\.com\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        // Enough of a stub to refuse a video on demand — the refusal state paints
        // `text-error` on two surfaces and is scanned below. `apps/music.spec.ts` owns the
        // protocol itself; all this has to do is load and answer.
        body:
          '<!doctype html><title>s</title><script>window.__error=(c)=>' +
          "parent.postMessage(JSON.stringify({event:'onError',info:c}),'*')</script>"
      })
    );

    // The artwork host, for the same reason and with the same consequence if it were left
    // out: since MICA-111 the now-playing card re-themes itself from the cover's dominant
    // colour, so an unstubbed thumbnail would mean this sweep measured a different palette
    // depending on whether YouTube answered — and axe's contrast rule is exactly the rule
    // that would notice. A solid red square, with the CORS header the canvas read needs, so
    // the card is tinted on every run and the M3 roles are what is being measured.
    await page.route(/https:\/\/img\.youtube\.com\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=',
          'base64'
        )
      })
    );
  });

  const frame = (page: Page) => page.getByTestId('phone-frame');
  const settled = async (page: Page) =>
    expect
      .poll(async () => frame(page).evaluate((el) => el.getAnimations({ subtree: true }).length), {
        timeout: 5000
      })
      .toBe(0);

  const openMusicWithATrack = async (page: Page) => {
    await page.goto('/?app=music');
    await settlePhoneOpen(page);
    const field = page.getByLabel('YouTube link');
    await field.fill('dQw4w9WgXcQ');
    await field.press('Enter');
    await expect(page.locator('button[aria-label="Stop music"]')).toBeVisible();
    await settled(page);
  };

  test('in the app', async ({ page }) => {
    await openMusicWithATrack(page);
    const app = await scan(page, 'music');
    expect(summarise(app), `music (loaded):\n  ${summarise(app).join('\n  ')}`).toEqual([]);
  });

  test('in the shade, playing', async ({ page }) => {
    await openMusicWithATrack(page);
    await page.getByRole('button', { name: 'Open notification shade' }).click();
    await expect(page.getByRole('group', { name: 'Now playing' })).toBeVisible();
    await settled(page);
    const shade = await scan(page, 'shade');
    expect(summarise(shade), `shade (playing):\n  ${summarise(shade).join('\n  ')}`).toEqual([]);
  });

  test('refused', async ({ page }) => {
    // The refusal state, which is its own palette: `text-error` on the now-playing card and
    // again on the queue row, neither of which appears on any other screen this file sweeps.
    // `error` is a role token so it should follow the scheme — the claim worth measuring
    // rather than assuming, as Bank's literal green once showed (a `KNOWN_OPEN` entry,
    // now fixed).
    //
    // Its own test, so it starts from a fresh page rather than closing the shade (a drag,
    // which `notifications.spec.ts` owns, with no close button to click).
    await openMusicWithATrack(page);
    await page
      .frameLocator('iframe[title="micaOS music player"]')
      .locator('body')
      .evaluate(() => (window as unknown as { __error: (code: number) => void }).__error(101));
    await expect(page.getByText("Can't play", { exact: true })).toBeVisible();
    await settled(page);

    const failed = await scan(page, 'music');
    expect(summarise(failed), `music (refused):\n  ${summarise(failed).join('\n  ')}`).toEqual([]);
  });
});

/**
 * The three built-in home-screen widgets, placed (MICA-245), at both sizes.
 *
 * A widget is text on a card the home grid draws, which the home scan above never sees
 * because nothing is placed by default. Music is scanned twice: empty (its own state, the
 * whole card a button) and with a track (artwork, title, transport). Seeded into the layout
 * rather than added through edit mode, which `home-widgets.spec.ts` owns.
 */
for (const size of ['2x1', '2x2'] as const) {
  // One scan per test (MICA-407): axe's cost scales with the DOM.
  const placed = async (page: Page) => {
    await page.route(/https:\/\/www\.youtube(-nocookie)?\.com\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>s</title>'
      })
    );
    await page.route(/https:\/\/img\.youtube\.com\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=',
          'base64'
        )
      })
    );
    // Four columns; each footprint is two cells wide, so anchors 0 and 2 share a row band
    // and 8 starts the next one at a 2x2.
    const anchors = size === '2x1' ? [0, 2, 4] : [0, 2, 8];
    await page.addInitScript(
      ({ size, anchors }: { size: string; anchors: number[] }) => {
        if (window !== window.top) return;
        if (window.localStorage.getItem('mica:settings:homeGridItems') !== null) return;
        const ids = ['shell.clock', 'shell.status', 'music'];
        window.localStorage.setItem(
          'mica:settings:homeGridItems',
          JSON.stringify(
            ids.map((widgetId, i) => ({
              position: anchors[i],
              kind: 'widget',
              widgetId,
              size
            }))
          )
        );
        window.localStorage.setItem('mica:settings:homeGridColumns', '4');
      },
      { size, anchors }
    );
    await page.goto('/');
    await settlePhoneOpen(page);
    for (const id of ['widget-clock', 'widget-status', 'widget-music-empty']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    const frame = page.getByTestId('phone-frame');
    const settled = async () =>
      expect
        .poll(async () => frame.evaluate((el) => el.getAnimations({ subtree: true }).length), {
          timeout: 5000
        })
        .toBe(0);
    await settled();
    return settled;
  };

  test(`placed widgets at ${size}, empty, have no accessibility violations`, async ({ page }) => {
    await placed(page);
    const empty = await scan(page, 'home');
    expect(summarise(empty), `widgets (empty):\n  ${summarise(empty).join('\n  ')}`).toEqual([]);
  });

  test(`placed widgets at ${size}, playing, have no accessibility violations`, async ({ page }) => {
    const settled = await placed(page);
    // Start a track from the Music app and come back: the widget now shows the player.
    await page.getByTestId('widget-music-empty').click();
    const field = page.getByLabel('YouTube link');
    await field.fill('dQw4w9WgXcQ');
    await field.press('Enter');
    await expect(page.locator('button[aria-label="Stop music"]')).toBeVisible();
    await page.locator("button[aria-label='Return to home screen']").click();
    await expect(page.getByTestId('widget-music')).toBeVisible();
    await settled();
    const playing = await scan(page, 'home');
    expect(summarise(playing), `widgets (playing):\n  ${summarise(playing).join('\n  ')}`).toEqual(
      []
    );
  });
}

/**
 * Streamer mode on, over every screen that draws a blurred picture inside a control (MICA-405).
 *
 * With the mode on, `MediaThumb` draws a still blurred under a "tap to reveal" overlay that
 * is itself focusable (MICA-249), and most thumbs sit inside a `<button>` that opens the
 * picture. Interactive content inside a button is axe's `nested-interactive` rule, and
 * nothing here ever saw it: every scan above runs with the mode off, where no overlay is
 * drawn at all, and `streamer-mode.spec.ts` proves the *state* (`data-streamer`) without
 * running axe. The two halves of the check lived in two files and neither could fail.
 *
 * The same scan, the same `scan()` and the same disabled rules as every test above: this is
 * a second pass over screens, not a second configuration. What is new is the precondition.
 * A scan of an unblurred thumb passes happily, so each test first waits for a still that
 * announces `data-streamer="blurred"` in the scope it is about to scan. If a surface stops
 * blurring (or stops drawing a picture), that wait fails and says so, rather than the pass
 * turning vacuous.
 *
 * Screens that draw a blurred still, by what holds it:
 *
 * - **inside a button:** the Media grid, a Messages attachment, a Glimpse profile grid, a
 *   Spark match row, the photo picker (reached from Snatchr's new listing and from Spark's
 *   editor), Camera's last-photo button, Settings > Display's wallpaper tiles.
 * - **free-standing:** a Glimpse post, Spark's deck and editor, a Blabber's picture. Not
 *   where `nested-interactive` bites, but the same overlay, so the same colour and name
 *   checks, and the first place to look if a restructure moves it into a control.
 *
 * What it does not reach: Snatchr's feed card and listing detail also draw a thumb inside a
 * button, but `marketplace:create` in the browser mock answers with `attachments: []` and
 * the fixture listings carry no photos, so neither can be shown a picture without a change
 * to `nui/mocks/` (`streamer-mode.spec.ts` records the same gap). Both go through the same
 * `MediaThumb` as the picker does. Nor does the tablet have a surface to sweep: the three
 * apps with a tablet root draw no picture, and Settings' wallpaper tiles are empty there
 * because the tablet's gallery is (the per-device mock), so `tablet/accessibility.spec.ts`
 * has nothing blurred to scan.
 */

/** The manifest's own answer, so a renamed app fails loudly instead of sweeping nothing. */
const appOf = (id: string) => {
  const app = APPS.find((a) => a.id === id);
  if (!app) throw new Error(`no app named '${id}' under src/apps/`);
  return app;
};

type Scope = Page | FrameLocator;

/**
 * The phone has stopped moving: a scan mid-transition measures colours still compositing.
 *
 * Counts animations that are still *running*, not every animation `getAnimations()` returns.
 * A modal's entrance (`animate-in`, `fill-mode: both`) stays in that list for as long as the
 * dialog is open, `finished` and holding its last frame, so the photo picker would never
 * reach zero and the wait the sweeps above use would time out on a screen that is perfectly
 * still.
 */
const settleFrame = async (page: Page): Promise<void> => {
  const frame = page.getByTestId('phone-frame');
  await expect
    .poll(
      async () =>
        frame.evaluate(
          (el) =>
            el.getAnimations({ subtree: true }).filter((a) => a.playState !== 'finished').length
        ),
      { timeout: 5000 }
    )
    .toBe(0);
};

/**
 * Pick the first still in an open photo picker, the way a streamer has to: a blurred tile
 * takes two taps on the tile itself, one to see what it is and one to choose it
 * (`streamer-mode.spec.ts`).
 * Matched on the attribute being present, since the reveal flips it to `revealed`.
 */
const pickRevealedPhoto = async (scope: Scope): Promise<void> => {
  const tile = scope
    .locator('button.aspect-square', { has: scope.locator('[data-streamer]') })
    .first();
  await tile.click();
  await tile.click();
};

/** Spark's editor, filled and holding one photo, not yet saved. */
const fillSparkEditor = async (frame: FrameLocator): Promise<void> => {
  await expect(frame.getByTestId('spark-editor')).toBeVisible();
  await frame.getByTestId('spark-name').fill('Ada');
  await frame.getByTestId('spark-age').fill('29');
  await frame.getByTestId('spark-bio').fill('Night shifts and good coffee.');
  await frame.getByTestId('spark-add-photo').click();
  const picker = frame.getByRole('dialog', { name: 'Choose photos' });
  await expect(picker).toBeVisible();
  await pickRevealedPhoto(frame);
  await picker.getByRole('button', { name: /^Done/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(frame.getByRole('button', { name: 'Remove photo' })).toHaveCount(1);
};

/** Opted in to Spark and looking at the first card of the deck. */
const optInToSparkDeck = async (frame: FrameLocator): Promise<void> => {
  await fillSparkEditor(frame);
  await frame.getByTestId('spark-save').click();
  await expect(frame.getByTestId('spark-editor')).toHaveCount(0);
  await expect(frame.getByTestId('spark-card')).toHaveCount(1);
};

/** Each opens its screen and hands back the scope the blurred still must appear in. */
const STREAMER_SURFACES: { surface: string; open: (page: Page) => Promise<Scope> }[] = [
  {
    surface: 'media grid',
    open: async (page) => {
      await openApp(page, appOf('media'));
      await expect(page.getByRole('button', { name: /^Open photo \d+/ }).first()).toBeVisible();
      return page;
    }
  },
  {
    surface: 'messages thread',
    open: async (page) => {
      await openApp(page, appOf('messages'));
      const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
      await expect(convItem).toBeVisible();
      await convItem.click({ force: true });
      const thread = page.locator('#messages-container');
      await expect(thread).toBeVisible();
      // Attachments sit on every twenty-fifth message, so one older page is enough to draw
      // the first. This used to load the whole thread (three clicks) and hand axe about
      // twice the DOM it needed: that scan took 18s under this file's own load and 37s
      // under the full suite's, past the 30s budget on cef-floor. The surface is about a
      // blurred still, and the slot assertion below still proves one is on screen.
      await thread.locator('button', { hasText: 'Load older messages' }).dispatchEvent('click');
      await expect(thread.getByTestId('attachment-slot').first()).toBeVisible();
      return page;
    }
  },
  {
    surface: 'glimpse feed',
    open: async (page) => {
      await openApp(page, appOf('glimpse'));
      const frame = addOnFrame(page, 'glimpse');
      await expect(frame.getByTestId('glimpse-post').first()).toBeVisible();
      return frame;
    }
  },
  {
    surface: 'glimpse profile grid',
    open: async (page) => {
      await openApp(page, appOf('glimpse'));
      const frame = addOnFrame(page, 'glimpse');
      await frame
        .locator('article[data-testid="glimpse-post"][data-post-id="11"]')
        .getByRole('button', { name: "Lena's profile" })
        .click();
      await expect(frame.getByTestId('glimpse-grid')).toBeVisible();
      return frame;
    }
  },
  {
    surface: 'spark photo picker',
    open: async (page) => {
      await openApp(page, appOf('spark'));
      const frame = addOnFrame(page, 'spark');
      await expect(frame.getByTestId('spark-editor')).toBeVisible();
      await frame.getByTestId('spark-add-photo').click();
      await expect(frame.getByRole('dialog', { name: 'Choose photos' })).toBeVisible();
      return frame;
    }
  },
  {
    surface: 'spark editor',
    open: async (page) => {
      await openApp(page, appOf('spark'));
      const frame = addOnFrame(page, 'spark');
      await fillSparkEditor(frame);
      return frame;
    }
  },
  {
    surface: 'spark deck',
    open: async (page) => {
      await openApp(page, appOf('spark'));
      const frame = addOnFrame(page, 'spark');
      await optInToSparkDeck(frame);
      return frame;
    }
  },
  {
    surface: 'spark matches',
    open: async (page) => {
      await openApp(page, appOf('spark'));
      const frame = addOnFrame(page, 'spark');
      await optInToSparkDeck(frame);
      // Maya has already liked the player, so liking her back is a match.
      await frame.getByTestId('spark-like').click();
      await expect(frame.getByTestId('spark-matched')).toBeVisible();
      await frame.getByTestId('spark-keep-swiping').click();
      await expect(frame.getByTestId('spark-matched')).toHaveCount(0);
      await frame.getByRole('button', { name: 'Matches', exact: true }).click();
      await expect(frame.getByTestId('spark-match')).toHaveCount(1);
      return frame;
    }
  },
  {
    surface: 'blabber feed',
    open: async (page) => {
      await openApp(page, appOf('blabber'));
      const frame = addOnFrame(page, 'blabber');
      await frame.getByRole('button', { name: 'Blab', exact: true }).click();
      await frame.locator('textarea').fill('pictured');
      await frame.getByRole('button', { name: 'Attach photo' }).click();
      await expect(frame.getByRole('dialog', { name: 'Select Photos' })).toBeVisible();
      await pickRevealedPhoto(frame);
      await frame.getByRole('button', { name: /^Done/ }).click();
      await frame.getByRole('button', { name: 'Post', exact: true }).click();
      const row = frame.locator('article', { hasText: 'pictured' });
      await expect(row).toBeVisible();
      return row;
    }
  },
  {
    surface: 'messages photo picker',
    open: async (page) => {
      await openApp(page, appOf('messages'));
      const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
      await expect(convItem).toBeVisible();
      await convItem.click({ force: true });
      await expect(page.locator('#messages-container')).toBeVisible();
      await page.getByRole('button', { name: 'Attachments' }).click();
      await page.getByRole('button', { name: 'Photo', exact: true }).click();
      await expect(page.getByRole('button', { name: /^Done/ })).toBeVisible();
      return page;
    }
  },
  {
    surface: 'snatchr photo picker',
    open: async (page) => {
      await openApp(page, appOf('marketplace'));
      await page.getByRole('button', { name: 'Create listing' }).click();
      await page.getByRole('button', { name: /Add photos/ }).click();
      await expect(page.getByRole('button', { name: /^Done/ })).toBeVisible();
      return page;
    }
  },
  {
    surface: 'camera gallery button',
    open: async (page) => {
      await openApp(page, appOf('camera'));
      return page;
    }
  },
  {
    surface: 'settings wallpaper photos',
    open: async (page) => {
      await openApp(page, appOf('settings'));
      await page.locator('button', { hasText: 'Display' }).first().click();
      await expect(page.locator('h1', { hasText: 'Display' })).toBeVisible();
      return page;
    }
  }
];

test.describe('with streamer mode on', () => {
  test.beforeEach(async ({ page }) => {
    await seedStreamerMode(page);
  });

  for (const { surface, open } of STREAMER_SURFACES) {
    test(`${surface} has no accessibility violations`, async ({ page }) => {
      await seedHomeGrid(page, ['settings']);
      const scope = await open(page);
      // The precondition. Without a blurred still on screen there is no overlay to judge.
      await expect(
        blurred(scope).first(),
        `${surface}: no still is blurred, so this scan would prove nothing`
      ).toBeVisible();
      await settleFrame(page);

      const results = await scan(page, `streamer: ${surface}`);
      expect(summarise(results), `${surface}:\n  ${summarise(results).join('\n  ')}`).toEqual([]);
    });
  }
});

/**
 * The photo picker, opened from every app that draws one, with streamer mode off (MICA-406).
 *
 * `PhotoPickerModal` is an `sdk/ui` modal that eight call sites share, and no sweep above
 * ever opened it: `openApp` stops at each app's first screen and the picker sits behind a
 * button. The streamer pass above reached it from Snatchr and Spark only, and with the mode
 * *on* — which is how its `<h3>` (the first heading on screen, so axe's `heading-order`)
 * was found, and why that finding was recorded as the overlay's when it was not: it fires
 * with the mode off too. So this is the pass that owns the picker itself, and the streamer
 * entries are the ones that owe it nothing.
 *
 * Same `scan()`, same disabled rules, no `KNOWN_OPEN` entry. Each test asserts the dialog is
 * open before scanning, so a renamed button fails loudly instead of scanning the screen
 * under a picker that never opened. Callers by `grep PhotoPickerModal web/src`: Snatchr's
 * new listing, Spark's editor, Blabber's and Glimpse's composers, Contacts' form and Messages'
 * composer.
 * (Glimpse's and Blabber's edit-profile screens name the modal in a comment only; neither
 * draws one.)
 *
 * Messages is here too (MICA-408): its Photo button opened nothing until the composer's
 * picker was wired, and this entry is what notices if it stops.
 */
const PICKER_SURFACES: { surface: string; open: (page: Page) => Promise<Scope> }[] = [
  {
    surface: 'snatchr',
    open: async (page) => {
      await openApp(page, appOf('marketplace'));
      await page.getByRole('button', { name: 'Create listing' }).click();
      await page.getByRole('button', { name: /Add photos/ }).click();
      return page;
    }
  },
  {
    surface: 'messages',
    open: async (page) => {
      await openApp(page, appOf('messages'));
      const convItem = page.locator('[role="button"]').filter({ hasText: 'Trevor' }).first();
      await expect(convItem).toBeVisible();
      await convItem.click({ force: true });
      await expect(page.locator('#messages-container')).toBeVisible();
      await page.getByRole('button', { name: 'Attachments' }).click();
      await page.getByRole('button', { name: 'Photo', exact: true }).click();
      return page;
    }
  },
  {
    surface: 'spark',
    open: async (page) => {
      await openApp(page, appOf('spark'));
      const frame = addOnFrame(page, 'spark');
      await expect(frame.getByTestId('spark-editor')).toBeVisible();
      await frame.getByTestId('spark-add-photo').click();
      return frame;
    }
  },
  {
    surface: 'blabber composer',
    open: async (page) => {
      await openApp(page, appOf('blabber'));
      const frame = addOnFrame(page, 'blabber');
      await frame.getByRole('button', { name: 'Blab', exact: true }).click();
      await frame.getByRole('button', { name: 'Attach photo' }).click();
      return frame;
    }
  },
  {
    surface: 'glimpse composer',
    open: async (page) => {
      await openApp(page, appOf('glimpse'));
      const frame = addOnFrame(page, 'glimpse');
      await frame.getByRole('button', { name: 'New post' }).click();
      await frame.getByRole('button', { name: 'Add photos' }).first().click();
      return frame;
    }
  },
  {
    surface: 'contacts form',
    open: async (page) => {
      await openApp(page, appOf('contacts'));
      await page.getByRole('button', { name: 'Add Contact' }).click();
      await page.getByRole('button', { name: 'Select photo from gallery' }).click();
      return page;
    }
  }
];

test.describe('with streamer mode off', () => {
  for (const { surface, open } of PICKER_SURFACES) {
    test(`${surface} photo picker has no accessibility violations`, async ({ page }) => {
      await seedHomeGrid(page, ['settings']);
      const scope = await open(page);
      // The precondition: the picker itself, not the screen under it.
      await expect(
        scope.getByRole('dialog', { name: /^(Select|Choose) .*photos?$/i }),
        `${surface}: the photo picker did not open, so this scan would prove nothing`
      ).toBeVisible();
      await settleFrame(page);

      const results = await scan(page, `picker: ${surface}`);
      expect(summarise(results), `${surface}:\n  ${summarise(results).join('\n  ')}`).toEqual([]);
    });
  }
});

/**
 * The focus ring, measured rather than assumed (MICA-109 item 2).
 *
 * There is no axe rule for this: a focusable element with an invisible ring is perfectly
 * conformant to every automated check and completely unusable with a keyboard. It matters
 * more since MICA-66 than it did before, because focus is now *trapped* in every modal —
 * a ring you cannot see inside a dialog you cannot Tab out of is the worst of both.
 *
 * `outline-width` on the computed style, not a screenshot: the ring is `2px solid
 * var(--color-focus-ring)` from `app.css`, and what this is guarding against is a call site
 * putting `outline: none` back on top of it.
 */
test('the focus ring is visible on whatever the keyboard reaches first', async ({ page }) => {
  await seedHomeGrid(page, ['settings', 'contacts']);
  await page.goto('/');
  await settlePhoneOpen(page);

  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
  });

  expect(ring, 'Tab moved focus to something').not.toBeNull();
  expect(ring!.style, 'the focused element draws an outline').not.toBe('none');
  expect(parseFloat(ring!.width)).toBeGreaterThanOrEqual(2);
});

/**
 * `shell/state/wallpaper.ts`'s fingerprint of a stored photo, which must stay in step with it:
 * a photo shows only while the synced `wallpaperOwner` row holds this value for it (MICA-433).
 * If the two drift, the test below fails on a default wallpaper rather than passing quietly.
 */
const wallpaperFingerprint = (image: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < image.length; i++) {
    hash ^= image.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * The one contrast question axe refuses to answer (MICA-109 item 1).
 *
 * A wallpaper is a picture the player supplied, so text drawn on it has no measurable
 * background — axe reports `incomplete` and moves on, and MICA-102 (a timestamp at about
 * 1.07:1) is what finding this class of bug by eye looks like.
 *
 * `.text-on-wallpaper` is what makes it answerable: a 3px `--color-surface` stroke under
 * `paint-order: stroke fill`, so the glyph's real background is `surface` and not the
 * photo. That reduces an unbounded question to a token pair the suite already measures —
 * `on-surface` on `surface` is 14.30:1 in dark and 16.28:1 in light (`m3.test.ts` holds the
 * floor at 4.5 across seeds). This asserts the mechanism is actually in place on the three
 * runs of text that sit on the wallpaper: the launcher heading, an app label, and the
 * status bar clock.
 */
test('the wallpaper treatment reaches every run of text drawn on a photo', async ({ page }) => {
  await seedHomeGrid(page, ['settings', 'contacts']);
  // A 1x1 PNG is enough: `wallpaperNeedsContrast` keys on `type`, not on the pixels. Stored as
  // the shell stores it, so the fingerprint is taken over the same string the shell reads.
  const image = wallpaperImage(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  );
  expect(image, 'the fixture is a photo the shell accepts').not.toBeNull();
  await page.addInitScript(
    ({ photo, owner }) => {
      window.localStorage.setItem(
        'mica:settings:wallpaper',
        JSON.stringify({ type: 'image', image: photo })
      );
      // The photo is this character's: the mock answers a seeded key as the server's row, so
      // the owner survives the character-load sweep exactly as a real one would (MICA-433).
      window.localStorage.setItem('mica:settings:wallpaperOwner', JSON.stringify(owner));
    },
    { photo: image!, owner: wallpaperFingerprint(image!) }
  );
  await page.goto('/');
  await settlePhoneOpen(page);

  const stroked = [
    { what: 'the launcher heading', locator: page.getByRole('heading', { name: 'micaOS' }) },
    { what: 'an app label', locator: page.getByText('Settings', { exact: true }).first() },
    {
      what: 'the status bar clock',
      locator: page.getByTestId('status-bar-row').locator('span').first()
    }
  ];

  for (const { what, locator } of stroked) {
    const measured = await locator.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        strokeWidth: style.webkitTextStrokeWidth,
        strokeColor: style.webkitTextStrokeColor,
        color: style.color,
        paintOrder: style.paintOrder
      };
    });
    expect(
      parseFloat(measured.strokeWidth),
      `${what} is stroked over a photo wallpaper`
    ).toBeGreaterThan(0);
    expect(measured.paintOrder, `${what} paints its stroke behind the glyph`).toContain('stroke');
    // The stroke is what the text is really read against, so this is the ratio that
    // decides legibility over any picture at all.
    expect(
      contrast(measured.color, measured.strokeColor),
      `${what}: glyph against its own stroke`
    ).toBeGreaterThanOrEqual(4.5);
  }
});

/**
 * An incoming call announces assertively (MICA-66 item 3, carried by MICA-109).
 *
 * Every other toast is `polite`, which queues behind whatever the reader is already
 * saying — correct for a message, useless for a ringing phone, which is the one event
 * where a late announcement has nothing left to announce. `ToastHost` swaps the politeness
 * with the toast's kind; this is the assertion that keeps it swapped.
 */
test('an incoming call announces assertively, and a message does not', async ({ page }) => {
  await page.goto('/');
  await settlePhoneOpen(page);
  const region = page.locator('[aria-live]').first();

  await page.evaluate(() => window.triggerTestToast('message'));
  await expect(region).toHaveAttribute('aria-live', 'polite');

  await page.evaluate(() => window.triggerTestToast('call'));
  await expect(region).toHaveAttribute('aria-live', 'assertive');
  await expect(region).toHaveAttribute('role', 'alert');
});

/**
 * Message bubbles that hold a control of their own (MICA-407).
 *
 * The plain thread sweep (`messages thread` above) never draws either: the seeded thread has
 * no quoted reply and no location, so a bubble that nests a second control inside its own
 * `<button>` scanned clean because the nested control was never on screen. Each test makes
 * its subject first, asserts it is visible, and only then scans — a scan of a thread that
 * lacks the control would pass for the wrong reason.
 */
test.describe('a message bubble that holds its own control', () => {
  const openTrevor = async (page: Page): Promise<Locator> => {
    await seedHomeGrid(page, ['settings', 'messages']);
    await openApp(page, appOf('messages'));
    await page
      .locator('[role="button"]')
      .filter({ hasText: 'Trevor' })
      .first()
      .click({ force: true });
    const thread = page.locator('#messages-container');
    await expect(thread).toBeVisible();
    return thread;
  };

  test('a quoted reply has no accessibility violations', async ({ page }) => {
    const thread = await openTrevor(page);
    await page.getByRole('textbox').last().fill('Original line');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await thread.locator('button', { hasText: 'Original line' }).last().click();
    await page.getByRole('button', { name: 'Reply to message' }).click();
    await page.getByRole('textbox').last().fill('Answering that');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(
      thread.getByText('Answering that'),
      'the reply did not arrive, so the quote cannot be on screen'
    ).toBeVisible();
    const quote = thread.getByTitle('Jump to original message');
    await expect(quote, 'the reply carries no quoted original').toBeVisible();
    await settleFrame(page);

    const results = await scan(page, 'messages quoted reply');
    expect(summarise(results), `quoted reply:\n  ${summarise(results).join('\n  ')}`).toEqual([]);
  });

  test('a shared location has no accessibility violations', async ({ page }) => {
    const thread = await openTrevor(page);
    await page.getByRole('button', { name: 'Attachments' }).click();
    await page.locator('button', { hasText: 'Location' }).click();
    await expect(page.getByRole('button', { name: 'Remove attachment' })).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(
      thread.locator('text=Vespucci Beach').last(),
      'the location card is not on screen'
    ).toBeVisible();
    await settleFrame(page);

    const results = await scan(page, 'messages location');
    expect(summarise(results), `location:\n  ${summarise(results).join('\n  ')}`).toEqual([]);
  });
});
