import { test, expect } from './support/test';
import { seedHomeGrid } from './support/homeGrid';

/**
 * MICA-363: the home screen stays mounted under an app, hidden rather than torn down.
 *
 * The DOM-observable half only. `Shell.svelte` wraps Home, Dock, Search and the drawer in
 * one `home-layer` box that is never removed: while an app is up it takes `invisible`,
 * `opacity-0` and `pointer-events-none` plus `inert`, and never `display:none` (that
 * collapses a widget iframe to 0x0, which CEF 103 does not reliably lay back out).
 *
 * What this cannot prove: how Chromium 103 in the release CEF composites the hidden layer
 * (the point of `opacity:0` over `visibility` alone). The `cef-floor` project is a real 103
 * binary, but headless with a software compositor; a green run says nothing about GPU layer
 * promotion in game.
 */
test.describe('Home layer residency', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['calculator']);
    await page.goto('/');
  });

  test('the home layer is hidden, not removed, under an app and returns as the same element', async ({
    page
  }) => {
    const layer = page.getByTestId('home-layer');
    await expect(layer).toBeVisible();
    await expect(layer).not.toHaveAttribute('inert', /.*/);

    // A marker on the element itself: a rebuilt layer would not carry it back.
    await layer.evaluate((el) => {
      (el as HTMLElement & { __mark?: string }).__mark = 'same-node';
    });

    await page
      .getByRole('button', { name: /calculator/i })
      .first()
      .click();
    await expect(page.locator('h1', { hasText: 'Calculator' })).toBeVisible();

    // Still in the DOM, hidden the way the commit hides it.
    await expect(layer).toHaveCount(1);
    await expect(layer).toHaveClass(/\binvisible\b/);
    await expect(layer).toHaveClass(/\bopacity-0\b/);
    await expect(layer).toHaveClass(/\bpointer-events-none\b/);
    await expect(layer).toHaveAttribute('inert', /.*/);
    // Never display:none, and not removed from layout: its box keeps its size.
    // Playwright counts `visibility:hidden` as hidden; the non-zero box below rules out
    // `display:none`, which would also read as hidden but collapses a widget iframe.
    await expect(layer).toBeHidden();
    const hiddenBox = await layer.boundingBox();
    expect(hiddenBox?.width ?? 0).toBeGreaterThan(0);
    expect(hiddenBox?.height ?? 0).toBeGreaterThan(0);

    await page.locator("button[aria-label='Return to home screen']").click();
    await expect(layer).not.toHaveClass(/\binvisible\b/);
    await expect(layer).not.toHaveAttribute('inert', /.*/);
    await expect(layer).toBeVisible();

    const mark = await layer.evaluate((el) => (el as HTMLElement & { __mark?: string }).__mark);
    expect(mark).toBe('same-node');
  });
});
