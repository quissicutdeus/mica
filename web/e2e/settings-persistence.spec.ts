import { test, expect, type Page } from '@playwright/test';

/**
 * Settings survive a reload, and hydration never eats them.
 *
 * Preferences moved from `localStorage` to a table keyed by citizenid, so that a player's
 * phone follows them to another machine and a second character does not inherit the
 * first's. `localStorage` stayed on as a **cache**, because `useStorage` is synchronous
 * and every store reads its key once at module scope.
 *
 * That arrangement has one failure mode worth a browser to catch: hydration runs on every
 * page load, and if it resets live stores instead of re-reading them — or treats an empty
 * response as "this player has nothing" — the phone silently returns to shipped defaults
 * every time it loads. The first version of the rehydrate did exactly that, because it
 * reused the reset callback `clearAppStorage` registers, which sets a store back to its
 * default.
 *
 * The browser mock's settings table is module scope, so a reload gives it back empty —
 * which makes this the empty-response case for free, and it is the dangerous one.
 */

const seed = (page: Page, key: string, value: unknown) =>
  page.addInitScript(([k, v]) => window.localStorage.setItem(k, v as string), [
    `gphone:settings:${key}`,
    JSON.stringify(value)
  ] as const);

const surfaceLightness = async (page: Page) => {
  const surface = await page
    .locator('[data-testid="phone-screen"]')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--color-surface').trim());
  const [r, g, b] = surface.match(/\d+/g)!.map(Number);
  return (r + g + b) / 3;
};

test('a stored preference survives hydration finding nothing', async ({ page }, testInfo) => {
  // Deliberately the opposite of whatever this project seeds, so the assertion cannot pass
  // by the default happening to match.
  const isLightProject = testInfo.project.name.endsWith('light');
  const chosen = isLightProject ? 'dark' : 'light';
  await seed(page, 'theme', { seed: '#155dfc', mode: chosen });

  await page.goto('/');
  // Past the point hydration runs — it is fired from `onMount` and not awaited, so the
  // regression this guards would land after first paint rather than before it.
  await expect(page.locator('[data-testid="phone-screen"]')).toBeVisible();
  await page.waitForTimeout(500);

  const lightness = await surfaceLightness(page);
  if (chosen === 'light') {
    expect(lightness, 'hydration reset the phone to the shipped theme').toBeGreaterThan(128);
  } else {
    expect(lightness, 'hydration reset the phone to the shipped theme').toBeLessThan(128);
  }
});

test('a preference changed in Settings is still there after a reload', async ({ page }) => {
  await page.goto('/');

  await page.locator('button', { hasText: 'Settings' }).first().click();
  await page.getByText('Display').first().click();

  // The appearance toggle is the one preference with a visible, binary result, so the
  // assertion can be about what the player sees rather than about a stored string.
  const before = await surfaceLightness(page);
  await page
    .getByRole('button', { name: before > 128 ? 'Dark' : 'Light' })
    .first()
    .click();

  await expect.poll(async () => (await surfaceLightness(page)) > 128).toBe(before <= 128);
  const after = await surfaceLightness(page);

  await page.reload();
  await expect(page.locator('[data-testid="phone-screen"]')).toBeVisible();
  await page.waitForTimeout(500);

  expect(
    Math.abs((await surfaceLightness(page)) - after),
    'the choice did not survive the reload'
  ).toBeLessThan(20);
});
