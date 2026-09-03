import { test, expect, type Page } from '../support/test';

/**
 * Mirrors `THUMBNAIL_SIZE` in `web/src/nui/mocks/data.ts` — the intrinsic width the mock
 * gives a photo's thumbnail, and the one size nothing else in the fixture set declares.
 *
 * Restated rather than imported: `e2e/` is outside every tsconfig in `web/` and no spec
 * here imports from `src/`, the same reason `support/homeGrid.ts` restates `PHONE_WIDTH`.
 * A drift is loud rather than silent — every assertion below is an equality against it, so
 * changing the fixture without changing this fails the suite instead of quietly passing.
 */
const THUMBNAIL_SIZE = 96;

/**
 * Fixture ids from `mocks/data.ts`, chosen to survive the mock growing real paging: under
 * both the array order the mock answers with today and the `id DESC` window the server
 * actually pages by, each of these is on the first page.
 */
const THUMBNAILED_PHOTO = 20;
const THUMBNAILLESS_PHOTO = 951;

/** Every photo tile in the grid. `Open photo <id>` is the tile button's own label. */
const photoTiles = (page: Page) => page.getByRole('button', { name: /^Open photo \d+$/ });

/**
 * What crossed the mock bridge, by event name — see `window.mockCalls` in `nui/transport.ts`.
 *
 * The browser mock is in-process, so a NUI call makes no request `page.route` could see.
 * Nothing else in this file could ask how many times the list was read.
 */
const mockCalls = (page: Page, event: string) =>
  page.evaluate((name) => (window.mockCalls ?? []).filter((call) => call.event === name), event);

/**
 * Which of a media row's two stills an `<img>` actually drew, by intrinsic size.
 *
 * Three outcomes rather than a width, because the two ways this can be wrong need telling
 * apart and a bare number tells you neither. `undecoded` is a `src` that never resolved to
 * an image — what a broken tile looks like from here, and indistinguishable from a working
 * one by any other DOM assertion. `thumbnail` is the small still, drawn where the original
 * was meant to be.
 *
 * Polled, and this is why it is a state rather than a reading: `naturalWidth` is 0 until
 * the bytes are in, and `PhotoDetail` renders `full ?? photo`, so an opened photo is
 * legitimately the thumbnail for as long as the fetch takes. A test that read once would
 * race that swap; one that polled for "not the thumbnail" would pass on the undecoded 0.
 */
const stillDrawn = async (page: Page, alt: string): Promise<'undecoded' | 'thumbnail' | 'full'> => {
  const img = page.locator(`img[alt="${alt}"]`);
  await expect(img).toBeVisible();
  return await img.evaluate((el, size) => {
    const width = (el as HTMLImageElement).naturalWidth;
    if (width === 0) return 'undecoded' as const;
    return width === size ? ('thumbnail' as const) : ('full' as const);
  }, THUMBNAIL_SIZE);
};

/** `stillDrawn`, waited on — for the two places the still legitimately changes after mount. */
const expectStill = (page: Page, alt: string) =>
  expect.poll(() => stillDrawn(page, alt), { timeout: 10_000 });

const openMedia = async (page: Page) => {
  await page.goto('/');
  await page.locator('button', { hasText: 'Media' }).first().click();
  await expect(page.locator('h1', { hasText: 'Media' })).toBeVisible();
  // The grid is behind a skeleton until the first page lands; every test below reads it.
  await expect(photoTiles(page).first()).toBeVisible();
};

test.describe('Media App E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'Media' }).first().click();
    await expect(page.locator('h1', { hasText: 'Media' })).toBeVisible();
  });

  test('renders Media app title and gallery area', async ({ page }) => {
    const title = page.locator('h1', { hasText: 'Media' });
    await expect(title).toBeVisible();
  });
});

/**
 * MICA-110 — the gallery drew 123px tiles by downloading every original at full size.
 *
 * **What this file cannot prove, stated first because it is the thing a green run here
 * would otherwise be read as saying.** It cannot show the size win. The mock fixtures are
 * ~0.9KB SVG placeholders where the rows this ticket is about are 270-800KB of base64, so
 * a byte count taken here would be a number about the fixtures and nothing else — and an
 * assertion like "the gallery is now small" would look like proof while proving the
 * opposite of what it claimed. The ticket says the same thing about its own measurement
 * step, and the one real measurement is `gosmedia` against a live library in game.
 *
 * What is provable is the *structure*, and it holds at any fixture size: the list read
 * carries no payload column, the grid draws the small still, opening a photo fetches and
 * draws the big one, and a row that never had a thumbnail still renders. Those are the
 * invariants that break silently if this regresses, and none of them care how many bytes
 * a placeholder happens to be.
 */
test.describe('Media gallery payloads (MICA-110)', () => {
  /**
   * The structural half of the ticket: the grid must not be handed originals at all.
   *
   * Read off the bridge rather than off the screen, because "the grid drew the thumbnail"
   * and "the grid was never sent the original" are different claims and only the second one
   * is the ticket. A row could arrive with both columns and render perfectly.
   *
   * **This asserts the mock's projection, not the server's**, and the distinction matters:
   * `getMedia` is answered here by `nui/mocks/registry.ts`, so a green run says the browser
   * mock agrees with what `server/services/Media.ts` declares — it does not re-prove the
   * declaration. `data: { private: true }` is what actually enforces this in game and the
   * test standing behind *that* belongs in `server/__tests__/`. What this catches is the
   * other half of the §8 trap: a mock that drifts back to answering with `data` would make
   * every render assertion below vacuous, and nothing else in the suite would notice.
   */
  test('the gallery list read carries thumbnails and metadata, never the full payload', async ({
    page
  }) => {
    await openMedia(page);

    const reads = await mockCalls(page, 'getMedia');
    expect(reads.length, 'opening the gallery must read the list at least once').toBeGreaterThan(0);

    for (const read of reads) {
      // The union of every row's keys, so one row carrying `data` fails even if the rest
      // are clean — which is the shape a half-applied projection would have.
      expect(read.keys, 'the list read must carry the small still').toContain('thumbnail');
      expect(read.keys, 'the list read must never carry the full payload').not.toContain('data');
    }
  });

  /**
   * The render half, and the reason the fixtures declare an intrinsic size at all.
   *
   * `naturalWidth` rather than a comparison of `src` strings: a spec that only asserted the
   * two URIs differ would pass just as happily if the thumbnail fixture were an unrelated
   * image, whereas this says the thing actually meant — the pixels the grid drew came from
   * the small one.
   */
  test('the grid draws the thumbnail, not the original', async ({ page }) => {
    await openMedia(page);

    await expectStill(page, `Capture ${THUMBNAILED_PHOTO}`).toBe('thumbnail');
  });

  /**
   * The regression this whole change risks, and the one a size win would not be worth: a
   * gallery that renders and a photo that will not open.
   *
   * With `data` off the list read, the full-size bytes exist nowhere on the client until
   * something goes and gets them. If that fetch is missing the tile still opens — onto the
   * thumbnail, upscaled — which looks like a working app and is the whole feature lost. So
   * the assertion is that the opened image is *not* the thumbnail, and has decoded.
   */
  test('opening a photo shows the full-resolution image, not the thumbnail', async ({ page }) => {
    await openMedia(page);

    await page.getByRole('button', { name: `Open photo ${THUMBNAILED_PHOTO}` }).click();
    await expect(page.locator('h1').filter({ hasText: /^Photo$/ })).toBeVisible();

    await expectStill(page, `Photo ${THUMBNAILED_PHOTO}`).toBe('full');

    // And the assertion above means what it says. Drawing the original is only an
    // achievement while the thumbnail is still *available* to be drawn instead — if the
    // single-row read ever stopped carrying `thumbnail`, `full` would be the only thing
    // left and this test would pass having proved nothing about precedence. So: the reply
    // carried both, and the view chose the bytes.
    // `some`, not the first or last call: the grid's own lazy hydration also reads single
    // rows, and those are the thumbnail-less ones, so a positional pick would read the
    // wrong reply. Only the opened photo is fetched carrying both.
    const reads = await mockCalls(page, 'media:item');
    expect(
      reads.some((read) => read.keys.includes('data') && read.keys.includes('thumbnail')),
      'the opened photo must arrive with both, so choosing the bytes is a real choice'
    ).toBe(true);
  });

  /**
   * The highest-value case in the ticket: it is the one that breaks for every existing
   * player and for nobody testing with fresh data.
   *
   * Photo 951 has bytes and no thumbnail — every row in a library that predates this change,
   * and still what `AddMedia` writes when an external resource drops a photo in. The list
   * read no longer carries the `data` such a row was drawn from, so without a fallback it is
   * a grey placeholder forever.
   *
   * `naturalWidth > 0` and not merely "an `<img>` is present": `MediaThumb` renders a
   * labelled `<div>` when it has no still, so the presence of an image element is already
   * most of the answer — but an `<img>` whose `src` never resolved is indistinguishable from
   * a working one by any DOM assertion except this one.
   */
  test('a photo that has never had a thumbnail still renders', async ({ page }) => {
    await openMedia(page);

    const tile = page.getByRole('button', { name: `Open photo ${THUMBNAILLESS_PHOTO}` });
    await expect(tile, 'the thumbnail-less row must still be in the grid').toBeVisible();

    await expectStill(page, `Capture ${THUMBNAILLESS_PHOTO}`).toBe('full');
  });

  /**
   * `media.load()` used to run on every incoming drop, so a push refetched the entire
   * library the player was already looking at — the second half of what made this app slow.
   *
   * Counted off the bridge, and the count alone is not the assertion: reading the head of
   * the list to pick up one new row is *also* one `getMedia` call, so a reload and a
   * reconcile are indistinguishable by call count. What tells them apart is what happens to
   * the window — a reload replaces it with a single page, a reconcile prepends into it — so
   * this pages in a second screenful first and asserts it survives.
   *
   * The call count still earns its place as the **barrier**. Asserting that a number did not
   * change is vacuous the instant after an event is dispatched, because nothing has had time
   * to change it; waiting for the one read the push legitimately causes is what makes the
   * tile count below an assertion about a settled state rather than about a race.
   */
  test('an incoming drop does not reload the library', async ({ page }) => {
    await openMedia(page);

    const tiles = photoTiles(page);
    const firstPage = await tiles.count();

    // Page two, so there is a window bigger than one page for a reload to destroy.
    const scroller = page.locator('[data-testid="phone-screen"] .overflow-y-auto').last();
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect.poll(() => tiles.count(), { timeout: 10_000 }).toBeGreaterThan(firstPage);
    const paged = await tiles.count();

    const before = (await mockCalls(page, 'getMedia')).length;
    await page.evaluate(() => window.pushAppEvent?.('media', 'media_received', {}));

    await expect
      .poll(async () => (await mockCalls(page, 'getMedia')).length, { timeout: 10_000 })
      .toBe(before + 1);

    await expect(tiles, 'a push must not throw away the pages already loaded').toHaveCount(paged);
  });
});
