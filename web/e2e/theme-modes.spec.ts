import { test, expect } from '@playwright/test';

/**
 * The guard on the two-project setup in `playwright.config.ts`.
 *
 * Every other spec runs twice, once per color scheme, and none of them asserts anything
 * about color — so if the `storageState` that seeds light mode ever stopped taking effect,
 * the suite would keep passing at double the wall time while testing one scheme twice.
 * That is a worse outcome than not having the second project at all, because the runtime
 * cost would still be paid and the coverage would be imaginary.
 *
 * This is the one spec that reads its own project name and checks the phone agrees.
 */
test('the phone renders the scheme its project asked for', async ({ page }, testInfo) => {
  await page.goto('/');

  const surface = await page
    .locator('[data-testid="phone-screen"]')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--color-surface').trim());

  // Parsed rather than string-matched: the literal moves whenever the seed or the M3
  // dependency changes, and pinning it here would make this a second copy of `app.css`.
  const [r, g, b] = surface.match(/\d+/g)!.map(Number);
  const lightness = (r + g + b) / 3;

  if (testInfo.project.name.endsWith('light')) {
    expect(lightness, `expected a light surface, got ${surface}`).toBeGreaterThan(128);
  } else {
    expect(lightness, `expected a dark surface, got ${surface}`).toBeLessThan(128);
  }
});

test('body text inverts with the scheme', async ({ page }, testInfo) => {
  // The surface alone is not proof: a scheme that changed its background and kept its text
  // would pass the check above and be unreadable. `on-surface` is what the reader sees.
  await page.goto('/');
  const onSurface = await page
    .locator('[data-testid="phone-screen"]')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--color-on-surface').trim());

  const [r, g, b] = onSurface.match(/\d+/g)!.map(Number);
  const lightness = (r + g + b) / 3;

  if (testInfo.project.name.endsWith('light')) {
    expect(lightness, `expected dark text, got ${onSurface}`).toBeLessThan(128);
  } else {
    expect(lightness, `expected light text, got ${onSurface}`).toBeGreaterThan(128);
  }
});
