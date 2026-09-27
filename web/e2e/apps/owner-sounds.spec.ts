import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';

/**
 * Owner sounds (MICA-256). The mock `shell:ownerConfig` answers one sample sound, served from
 * `public/mock-branding/sounds/`. What is asserted is the picker state and its persistence,
 * never audio output: Playwright cannot hear, and its Chromium is not CEF.
 */

test.describe('owner sounds', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['settings', 'contacts']);
    await page.goto('/');
  });

  test('Sound lists the sample beside the built-ins, and the choice survives a reload', async ({
    page
  }) => {
    const openSound = async () => {
      await page.locator('button', { hasText: 'Settings' }).first().click();
      await page.getByRole('button', { name: new RegExp('^Sound\\b') }).click();
      await expect(page.locator('h1', { hasText: 'Sound' })).toBeVisible();
    };
    await openSound();

    await expect(page.getByTestId('ringtone-option')).toHaveCount(6);
    await expect(page.getByTestId('notification-tone-option')).toHaveCount(2);

    await page.getByTestId('ringtone-option').filter({ hasText: 'Sample Tone' }).click();
    await page.getByTestId('notification-tone-option').filter({ hasText: 'Sample Tone' }).click();
    await expect(
      page.getByTestId('ringtone-option').filter({ hasText: 'Sample Tone' })
    ).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await openSound();
    await expect(
      page.getByTestId('ringtone-option').filter({ hasText: 'Sample Tone' })
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByTestId('notification-tone-option').filter({ hasText: 'Sample Tone' })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test("a contact's ringtone picker lists the sample", async ({ page }) => {
    await page.locator('button', { hasText: 'Contacts' }).first().click();
    await expect(page.locator('h1', { hasText: 'Contacts' })).toBeVisible();
    // A contact row is `ListItem` — a `div[role="button"]`, not a `<button>` element.
    await page
      .getByRole('button', { name: /Ursula/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    const options = page.getByTestId('contact-ringtone-option');
    await expect(options).toHaveCount(7);
    await expect(options.first()).toHaveText(/System default/);
    await options.filter({ hasText: 'Sample Tone' }).click();
    await expect(options.filter({ hasText: 'Sample Tone' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
