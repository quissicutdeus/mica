import { test, expect } from './support/test';

test.describe('FiveM NUI Phone Interface', () => {
  test('renders phone container and initializes in browser mode', async ({ page }) => {
    await page.goto('/');

    // Main phone wrapper container should be visible in browser mode
    const mainElement = page.locator('main');
    await expect(mainElement).toBeVisible();

    // Verify phone frame container element. By test id rather than by its height class:
    // the frame's size is now a `style` attribute driven by `state/display.ts`, because
    // the phone is scaled to fit the window (`display.spec.ts` covers that).
    await expect(page.getByTestId('phone-frame')).toBeVisible();
  });

  test('handles NUI window message events', async ({ page }) => {
    await page.goto('/');

    // Dispatch custom setVisible false message to hide phone
    await page.evaluate(() => {
      window.postMessage({ action: 'setVisible', data: false }, '*');
    });

    const mainElement = page.locator('main');
    await expect(mainElement).toBeHidden();

    // Dispatch setVisible true to show phone again
    await page.evaluate(() => {
      window.postMessage({ action: 'setVisible', data: true }, '*');
    });

    await expect(mainElement).toBeVisible();
  });
});

/**
 * The fixture in `support/test.ts` fails a spec whose page printed a NUI failure — the
 * gate that makes a missing browser mock visible (MICA-195). A gate is only worth having
 * if it can be seen to fire, so this spec provokes exactly that: a read of an action no
 * mock answers, made through the harness handle because nothing on the phone's own
 * surface reaches an unmocked action. The registry throws, `fetchNui` warns and hands back
 * the default, and the fixture must turn that warning into a failed test at teardown.
 *
 * `test.fail()` inverts the verdict: the run is green only when this test goes red. If the
 * fixture ever stops listening — a renamed console message, a loosened pattern, a lost
 * `page.on('console')` — this test passes on its own terms and the suite fails here,
 * rather than every other spec quietly losing its gate.
 */
test.describe('a NUI call with no browser mock', () => {
  test('fails the spec that made it', async ({ page }) => {
    test.fail(true, 'MICA-195: the fixture must fail a spec that reached an unmocked action');
    await page.goto('/');
    await expect(page.getByTestId('phone-frame')).toBeVisible();

    const reply = await page.evaluate(() =>
      window.fetchNui!('gphoneE2eNoSuchAction', {}, { defaultValue: 'default' })
    );
    // The call itself does not throw: a read with a default falls back, and only the
    // console line it printed on the way is what the fixture is meant to catch.
    expect(reply).toBe('default');
  });
});
