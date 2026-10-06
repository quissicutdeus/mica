import { test as base, expect, type Page } from './support/test';
import { addOnFrame } from './support/addon';
import {
  DEV_APP_ID,
  DEV_BASE,
  buildDevAddon,
  serveDevAddon,
  watchRequests,
  type BuiltDevAddon
} from './support/devAddon';

/**
 * The add-on dev loop, end to end (MICA-311): `?addonDev=<loopback base>` loads an add-on
 * from the author's own machine into the ordinary sandboxed frame.
 *
 * The add-on is real. `fixtures/dev-addon/` is built by the out-of-tree template's own
 * `vite.config.ts` in development mode (see `support/devAddon.ts`), so the bundle carries the
 * in-frame mock of its server half and `mica-dev.json` is the entry the template writes, not
 * one invented here. The e2e build is `--mode development`, which is what lets the shell's
 * dev path exist at all; a game build has no such code (`scripts/check-no-dev-addon.js`).
 *
 * `page.route` stands in for the template's dev server. Every request the page makes is
 * watched through the `request` event, which fires whether or not a route answers or aborts
 * it — so "zero requests to the bad origin" is counted, not inferred, and the happy path
 * proves the counter sees requests at all.
 *
 * What this cannot show: FiveM's CEF 103 over a real socket, Chrome's Private Network Access
 * preflight from the public demo (the dev server's answer to it is read as text in
 * `addonTemplate.test.ts`), and anything in game.
 */

/** One build per worker: it is the slow part, and the output is never written to. */
const test = base.extend<object, { built: BuiltDevAddon }>({
  built: [
    async ({}, use) => {
      const built = await buildDevAddon();
      try {
        await use(built);
      } finally {
        built.dispose();
      }
    },
    { scope: 'worker', timeout: 150_000 }
  ]
});

const DEV_ORIGIN = new URL(DEV_BASE).origin;
const withDevAddon = (addonBase: string): string => `/?addonDev=${encodeURIComponent(addonBase)}`;

const strip = (page: Page) => page.getByTestId('mica-dev-addon');

/** The shell's own toast for a refused load — the one place a boot refusal is shown. */
const refusalToast = (page: Page) => page.getByText('Dev add-on not loaded');

const paths = (urls: string[]) => urls.map((url) => new URL(url).pathname);

test.describe('a dev add-on', () => {
  test('loads from loopback, mounts sandboxed, answers from its mock, pushes, and reloads', async ({
    page,
    built
  }) => {
    const requests = watchRequests(page);
    const served = await serveDevAddon(page, built);
    await page.goto(withDevAddon(DEV_BASE));

    // It opens by itself, with the shell's strip above the frame saying where it came from.
    await expect(strip(page)).toContainText('Dev add-on from 127.0.0.1:5174, not verified');
    const frame = addOnFrame(page, DEV_APP_ID);

    // The mocked `list` answer, rendered by the add-on's own UI inside the frame. The UI's
    // default for a failed call is an empty list, so these rows can only have come from the mock.
    await expect(frame.getByTestId('rows')).toContainText('seeded by the mock');

    // Both files were fetched, once each, and nothing else was asked of the dev server.
    expect(paths(requests.to(DEV_ORIGIN))).toEqual([
      '/mica-dev.json',
      `/${built.bundleUrl.split('?')[0]}`
    ]);

    // A push: the mock's `add` handler pushes `row_added`, which `useAppEvents` hears. The
    // pushed list is separate from the rows, so this is the event and not the answer.
    await frame.getByTestId('add').click();
    await expect(frame.getByTestId('pushed')).toContainText('pushed: added by a click');

    // Still the ordinary sandbox: scripts only, a CSP, an opaque origin.
    const iframe = page.locator(`iframe[data-app="${DEV_APP_ID}"]`);
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    const srcdoc = (await iframe.getAttribute('srcdoc')) ?? '';
    expect(srcdoc).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");

    // Reload re-fetches both files and runs what it fetched. The dev server now answers a
    // rebuilt bundle (the mock's seed text changed), so only a frame booted from the new bytes
    // can show it — and the pushed line, which only the old frame held, is gone with it.
    const rebuilt = built.bundle.replace('seeded by the mock', 'reseeded by the mock');
    expect(rebuilt, 'the fixture no longer contains the seed text').not.toBe(built.bundle);
    served.setBundle(rebuilt);
    const before = requests.to(DEV_ORIGIN).length;
    await page.getByTestId('mica-dev-addon-reload').click();
    await expect.poll(() => requests.to(DEV_ORIGIN).length).toBe(before + 2);
    await expect(frame.getByTestId('rows')).toContainText('reseeded by the mock');
    await expect(frame.getByTestId('pushed').locator('li')).toHaveCount(0);
    await expect(page.getByTestId('mica-dev-addon-reload')).toBeEnabled();
    await expect(page.getByTestId('mica-dev-addon-error')).toHaveCount(0);
  });

  test('a failed Reload leaves the running copy up and says why in the strip', async ({
    page,
    built
  }) => {
    await serveDevAddon(page, built);
    await page.goto(withDevAddon(DEV_BASE));
    const frame = addOnFrame(page, DEV_APP_ID);
    await expect(frame.getByTestId('rows')).toContainText('seeded by the mock');

    // The dev server stops answering the entry. A later route wins over the earlier one.
    await page.route(`${DEV_BASE}mica-dev.json`, (route) =>
      route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: '' })
    );
    await page.getByTestId('mica-dev-addon-reload').click();

    await expect(page.getByTestId('mica-dev-addon-error')).toContainText('HTTP 500');
    await expect(frame.getByTestId('rows')).toContainText('seeded by the mock');
  });

  test('leaves nothing behind once loaded without the parameter', async ({ page, built }) => {
    const requests = watchRequests(page);
    await serveDevAddon(page, built);
    await page.goto(withDevAddon(DEV_BASE));
    await expect(strip(page)).toBeVisible();

    // The control: while it is loaded, the app is in the phone's own search. Without this
    // the absences below would pass just as happily if search never listed an add-on.
    await page.getByRole('button', { name: 'Return to home screen' }).click();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByLabel('Search your phone').fill('Dev Probe');
    const drawer = page.getByRole('dialog', { name: 'App Drawer' });
    await expect(drawer.getByRole('button', { name: /Dev Probe/ })).toBeVisible();

    // The same browser profile, the same storage, a fresh page and no parameter.
    const seen = requests.to(DEV_ORIGIN).length;
    expect(seen).toBeGreaterThan(0);
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'micaOS' })).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
    await expect(page.locator(`iframe[data-app="${DEV_APP_ID}"]`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Dev Probe/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByLabel('Search your phone').fill('Dev Probe');
    // The empty state quotes the query, so "no result" is the sheet's own message, and the
    // absence is of a result button — not of the words.
    await expect(page.getByText('No results for "Dev Probe"')).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'App Drawer' }).getByRole('button', { name: /Dev Probe/ })
    ).toHaveCount(0);
    expect(requests.to(DEV_ORIGIN)).toHaveLength(seen);
  });
});

test.describe('a dev add-on is refused', () => {
  /**
   * A base the shell must refuse **before** any request. `leaks` is the origin a request to
   * would be a breach: the bad host itself, or — for the bases whose host is the dev
   * server's own — the dev server, which is served with a working add-on so a leak would
   * mount it and fail the absence checks below as well.
   */
  const REFUSED: [label: string, base: string, leaks: string, reason: RegExp][] = [
    ['an https host', 'https://evil.example/', 'https://evil.example', /not loopback/],
    ['another loopback address', 'http://127.0.0.2:5174/', 'http://127.0.0.2:5174', /not loopback/],
    ['a lookalike host', 'http://localhost.evil.com/', 'http://localhost.evil.com', /not loopback/],
    ['a username and password', 'http://user:pw@127.0.0.1:5174/', DEV_ORIGIN, /no username/],
    ['a query string', 'http://127.0.0.1:5174/?x=1', DEV_ORIGIN, /no query/]
  ];

  for (const [label, addonBase, leaks, reason] of REFUSED) {
    test(`${label}, with no request to it`, async ({ page, built }) => {
      const requests = watchRequests(page);
      await serveDevAddon(page, built);
      // Nothing may leave the machine, in this test or by a bug in the shell.
      await page.route(`${leaks}/**`, (route) => route.abort());
      await page.goto(withDevAddon(addonBase));

      await expect(refusalToast(page)).toBeVisible();
      await expect(page.getByText(reason)).toBeVisible();
      expect(requests.to(leaks)).toEqual([]);
      await expect(strip(page)).toHaveCount(0);
      await expect(page.locator(`iframe[data-app="${DEV_APP_ID}"]`)).toHaveCount(0);
    });
  }

  test('an entry that answers 302 to elsewhere: one request, then refused', async ({ page }) => {
    const requests = watchRequests(page);
    await page.route(`${DEV_BASE}**`, (route) =>
      route.fulfill({
        status: 302,
        headers: { location: 'https://evil.example/mica-dev.json' }
      })
    );
    await page.route('https://evil.example/**', (route) => route.abort());
    await page.goto(withDevAddon(DEV_BASE));

    await expect(refusalToast(page)).toBeVisible();
    await expect(page.getByText(/redirect/i).first()).toBeVisible();
    expect(paths(requests.to(DEV_ORIGIN))).toEqual(['/mica-dev.json']);
    expect(requests.to('https://evil.example')).toEqual([]);
    await expect(page.locator(`iframe[data-app="${DEV_APP_ID}"]`)).toHaveCount(0);
  });

  test('a bundleUrl on another origin: the entry is fetched, the bundle is not', async ({
    page,
    built
  }) => {
    const requests = watchRequests(page);
    const entry = JSON.parse(built.entry) as Record<string, unknown>;
    entry.bundleUrl = `https://evil.example/${DEV_APP_ID}.js`;
    await page.route(`${DEV_BASE}**`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify(entry)
      })
    );
    await page.route('https://evil.example/**', (route) => route.abort());
    await page.goto(withDevAddon(DEV_BASE));

    await expect(refusalToast(page)).toBeVisible();
    await expect(page.getByText(/is not on http:\/\/127\.0\.0\.1:5174/)).toBeVisible();
    expect(paths(requests.to(DEV_ORIGIN))).toEqual(['/mica-dev.json']);
    expect(requests.to('https://evil.example')).toEqual([]);
    await expect(page.locator(`iframe[data-app="${DEV_APP_ID}"]`)).toHaveCount(0);
  });
});
