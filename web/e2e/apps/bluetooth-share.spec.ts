import { test, expect } from '@playwright/test';

/**
 * Proximity contact sharing, end to end against the mock.
 *
 * `?bluetoothNearby=N` is the mock's only knob for this feature — there is no other
 * player in the browser to actually be nearby — so these two specs are what makes both
 * outcomes (delivered / nobody in range) reachable at all, matching the reasoning
 * `web/src/nui/mocks/registry.ts` documents beside the flag.
 */
test.describe('Bluetooth proximity contact share', () => {
  const openUrsula = async (page: import('@playwright/test').Page) => {
    await page.getByRole('button', { name: 'Contacts' }).click();
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();

    await page.getByRole('button', { name: /Ursula/ }).click();
    await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
  };

  test('says so when nobody is Bluetooth-visible nearby', async ({ page }) => {
    await page.goto('/');
    await openUrsula(page);

    await page.getByRole('button', { name: 'Share' }).click();

    const toastCard = page.locator('.pointer-events-auto', { hasText: 'Nobody nearby' });
    await expect(toastCard).toBeVisible();
    await expect(toastCard.getByText('No Bluetooth-visible players are in range.')).toBeVisible();
  });

  test('reports how many nearby phones received the contact', async ({ page }) => {
    await page.goto('/?bluetoothNearby=2');
    await openUrsula(page);

    await page.getByRole('button', { name: 'Share' }).click();

    const toastCard = page.locator('.pointer-events-auto', { hasText: 'Contact shared' });
    await expect(toastCard).toBeVisible();
    await expect(toastCard.getByText('Shared with 2 nearby phones.')).toBeVisible();
  });
});
