import { test, expect } from '@playwright/test';

/**
 * The now-playing card's album-art tint, in a real browser (MICA-111).
 *
 * ## Why this is not in `music.spec.ts`
 *
 * It reads a `--color-*` value back out of the DOM, which is the one kind of assertion
 * that differs between the light and dark schemes — so it has to run in both, and
 * `THEME_SPECS` in `playwright.config.ts` is how a spec asks for that. Adding the whole of
 * `music.spec.ts` to that list would run thirty-odd tests twice to double-check one, which
 * is exactly the waste that list was trimmed down to avoid (`lib/e2eThemeCoverage.test.ts`
 * keeps both directions honest). So the colour assertion lives in its own file.
 *
 * ## What only a real browser can show
 *
 * Everything below this level can be mocked into agreeing with itself: the unit test stubs
 * the canvas, and the component test stubs the extraction outright. What neither can show
 * is that a cross-origin image can be drawn into a canvas and read back at all — that is
 * the browser's own CORS decision, and it is the single part of this feature most likely
 * to be lost in game. The stub below sends `access-control-allow-origin`, so a failure
 * here means our half is broken rather than YouTube's.
 *
 * What it still cannot answer is whether `img.youtube.com` is reachable from a `cfx-nui-`
 * origin, or whether it sends that header there. Both are open (`docs/testing-music-in-cef.md`),
 * and the degrade path — an untinted card, never a broken one — is what covers being wrong
 * about either.
 */

const VIDEO = 'dQw4w9WgXcQ';

/**
 * An 8x8 solid red PNG, served in place of every YouTube thumbnail.
 *
 * Red so the tint has to be visibly the artwork's colour rather than the phone's own blue,
 * and flat because the assertion is about the wiring — `lib/dominantColor.test.ts` owns
 * the picking.
 */
const STUB_ARTWORK =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=';

test.beforeEach(async ({ page }) => {
  // The embed, stubbed to nothing at all: this spec never asks the player to do anything,
  // and the card draws from queue state rather than from the frame. `music.spec.ts` owns
  // the protocol. Both YouTube origins, so nothing leaves the machine.
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
      body: Buffer.from(STUB_ARTWORK, 'base64')
    })
  );

  await page.goto('/?app=music');
  const field = page.getByLabel('YouTube link');
  await expect(field).toBeVisible();
  await field.fill(VIDEO);
  await field.press('Enter');
});

test('tints the now-playing card from the artwork', async ({ page }) => {
  const card = page.getByTestId('now-playing-card');
  await expect(card).toBeVisible();

  // Asserted on the *roles* rather than on a painted colour: the card is re-themed by
  // shadowing the `--color-*` custom properties for its own subtree, so every class inside
  // it is the same role name it always was and the `on-` roles keep their contrast.
  const surface = async () =>
    card.evaluate((el) => el.style.getPropertyValue('--color-surface-container-low').trim());
  await expect.poll(surface).not.toBe('');

  const value = await surface();
  // A plain `rgb()`, because these values go straight into a `style` attribute and never
  // pass through PostCSS — CEF is Chromium 103 and has no `color-mix()` (AGENTS.md §6).
  expect(value).toMatch(/^rgb\(\d+, \d+, \d+\)$/);

  // A red cover has to come out warm, and it has to do so in both schemes: light inverts
  // the tone but not the hue, so red stays red either way.
  const [r, , b] = value.match(/\d+/g)!.map(Number);
  expect(r).toBeGreaterThan(b);
});

/**
 * The other half of the same claim, and the one that is easy to lose: the *displayed*
 * cover must not carry `crossorigin`. The tint's request is a second, anonymous one, and
 * folding the two into one attribute would mean a host that declines CORS renders no
 * picture at all — trading a missing tint for a missing cover.
 */
test('draws the cover without making it depend on CORS', async ({ page }) => {
  const cover = page.getByTestId('now-playing-card').locator('img');
  await expect(cover).toBeVisible();
  expect(await cover.getAttribute('crossorigin')).toBeNull();
});
