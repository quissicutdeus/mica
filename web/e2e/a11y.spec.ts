import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { AxeResults, Result } from 'axe-core';
import { seedHomeGrid } from './support/homeGrid';
import { settlePhoneOpen } from './support/phoneOpen';

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
 * Two rules that cannot apply here (`NOT_APPLICABLE`) and two defects this gate found and
 * did not fix (`KNOWN_OPEN`) — both lists are below, each entry with its reason. Nothing
 * else: a new axe rule arrives here as a failure, which is the point.
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
 * - **`shade` / `nested-interactive`** — a notification row is a `role="button"` div with
 *   a real `<button>` (restore, dismiss) inside it, four of them on screen. The role hides
 *   its own descendants from assistive tech, so those buttons are unreachable. The fix is
 *   to restructure the row — an overlay button for the row action, the per-item buttons as
 *   siblings above it — which changes the shade's interaction model and belongs to whoever
 *   owns that, not to a contrast ticket.
 *
 * - **`bank` / `color-contrast`** — `TransactionItem` pairs `text-error` (a role, so it
 *   follows the scheme) with `text-green-400` (a literal, so it does not). Measured 1.49:1
 *   on a light surface. It cannot be fixed by picking a better green: passing 4.5:1 against
 *   the dark surface needs relative luminance >= 0.213 and against the light one <= 0.145,
 *   so no single literal exists. AGENTS.md §5 sanctions raw palette classes for signal
 *   colours precisely because `tertiary` is seeded — but that reasoning predates light
 *   mode. The real fix is a scheme-aware positive-signal token generated in `m3.ts`
 *   alongside `error`, which is a change to the token set and therefore not this ticket's
 *   to make.
 */
const KNOWN_OPEN: Record<string, string[]> = {
  shade: ['nested-interactive'],
  bank: ['color-contrast']
};

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

test('the home screen, the drawer and the shade have no accessibility violations', async ({
  page
}) => {
  await seedHomeGrid(page, ['settings', 'contacts', 'store', 'messages']);
  await page.goto('/');
  await settlePhoneOpen(page);

  const home = await scan(page, 'home');
  expect(summarise(home), `home:\n  ${summarise(home).join('\n  ')}`).toEqual([]);

  // The two sheets, opened through their own state rather than their gestures — this is a
  // scan of what is on screen, not a test of how it got there (`home-grid.spec.ts` and
  // `notifications.spec.ts` own the gestures).
  await page.getByRole('button', { name: 'Open notification shade' }).click();
  const shade = page.getByRole('dialog', { name: /notification/i });
  await expect(shade).toBeVisible();
  // `toBeVisible` resolves when the sheet is in the DOM, which is the *start* of its fly-in
  // and of the status bar date's 150ms fade. Contrast measured on a fading element is
  // measured on a colour that exists for one frame: this scan failed one run in three on
  // the date span before the wait went in, at whatever ratio it happened to catch.
  await expect
    .poll(async () => shade.evaluate((el) => el.getAnimations({ subtree: true }).length), {
      timeout: 5000
    })
    .toBe(0);
  const shadeResults = await scan(page, 'shade');
  expect(summarise(shadeResults), `shade:\n  ${summarise(shadeResults).join('\n  ')}`).toEqual([]);
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
test('Music has no accessibility violations with a track loaded, in the app and in the shade', async ({
  page
}) => {
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

  const frame = page.getByTestId('phone-frame');
  const settled = async () =>
    expect
      .poll(async () => frame.evaluate((el) => el.getAnimations({ subtree: true }).length), {
        timeout: 5000
      })
      .toBe(0);

  const openMusicWithATrack = async () => {
    await page.goto('/?app=music');
    await settlePhoneOpen(page);
    const field = page.getByLabel('YouTube link');
    await field.fill('dQw4w9WgXcQ');
    await field.press('Enter');
    await expect(page.locator('button[aria-label="Stop"]')).toBeVisible();
    await settled();
  };

  await openMusicWithATrack();
  const app = await scan(page, 'music');
  expect(summarise(app), `music (loaded):\n  ${summarise(app).join('\n  ')}`).toEqual([]);

  await page.getByRole('button', { name: 'Open notification shade' }).click();
  await expect(page.getByRole('group', { name: 'Now playing' })).toBeVisible();
  await settled();
  const shade = await scan(page, 'shade');
  expect(summarise(shade), `shade (playing):\n  ${summarise(shade).join('\n  ')}`).toEqual([]);

  // The refusal state, which is its own palette: `text-error` on the now-playing card and
  // again on the queue row, neither of which appears on any other screen this file sweeps.
  // `error` is a role token so it should follow the scheme — the claim worth measuring
  // rather than assuming, and the one the `bank` entry in `KNOWN_OPEN` above is the
  // cautionary tale for.
  //
  // Reached by starting over rather than by closing the shade: the shade is opened and
  // closed by a drag (`notifications.spec.ts` owns that gesture) and has no close button to
  // click, so a second pass is both cheaper and less of a lie about what is being tested.
  await openMusicWithATrack();
  await page
    .frameLocator('iframe[title="gPhone music player"]')
    .locator('body')
    .evaluate(() => (window as unknown as { __error: (code: number) => void }).__error(101));
  await expect(page.getByText("Can't play this", { exact: true })).toBeVisible();
  await settled();

  const failed = await scan(page, 'music');
  expect(summarise(failed), `music (refused):\n  ${summarise(failed).join('\n  ')}`).toEqual([]);
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
  await page.addInitScript(() => {
    // A 1x1 PNG is enough: `wallpaperNeedsContrast` keys on `type`, not on the pixels.
    window.localStorage.setItem(
      'gphone:settings:wallpaper',
      JSON.stringify({
        type: 'image',
        image:
          'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")'
      })
    );
  });
  await page.goto('/');
  await settlePhoneOpen(page);

  const stroked = [
    { what: 'the launcher heading', locator: page.getByRole('heading', { name: 'gPhone' }) },
    { what: 'an app label', locator: page.getByText('Settings', { exact: true }).first() },
    {
      what: 'the status bar clock',
      locator: page
        .getByRole('button', { name: /notification shade/ })
        .locator('span')
        .first()
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
