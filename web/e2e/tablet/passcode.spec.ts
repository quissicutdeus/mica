import { test, expect } from '../support/test';
import { bootWithStore, goHome, switchTo } from '../support/deviceStore';

/**
 * The tablet has a lock screen and a passcode of its own (MICA-264). A passcode set on one
 * device must not lock the other, and the device that has one must come up locked when it is
 * raised again.
 *
 * Locking is by switching: `auto_lock_policy` defaults to `onClose`, and leaving a device for
 * the other is closing it, so the way a player locks the tablet is to raise the phone and
 * then the tablet again. That is the same path the product takes (`state/deviceIdentity.ts`),
 * not a test hook.
 */
const PASSCODE = '4321';

const openTabletPasscodeSettings = async (page: import('@playwright/test').Page) => {
  await page
    .getByRole('region', { name: 'Home Screen' })
    .getByRole('button', { name: /Settings/ })
    .click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: /^Lock Screen/ })
    .click();
};

const lockScreen = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog', { name: 'Lock screen' });

test('a passcode set on the tablet locks the tablet, not the phone', async ({ page }) => {
  await bootWithStore(page, 'tablet', { phone: ['settings'], tablet: ['settings'] });
  await expect(lockScreen(page)).toHaveCount(0);

  await openTabletPasscodeSettings(page);
  await page.getByRole('button', { name: 'Set Passcode' }).click();
  await page.getByPlaceholder('New passcode').fill(PASSCODE);
  await page.getByPlaceholder('Confirm passcode').fill(PASSCODE);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Passcode is set')).toBeVisible();
  await goHome(page);

  // The phone has no passcode: it opens on its home screen, unlocked.
  await switchTo(page, 'phone');
  await expect(page.getByRole('region', { name: 'Home Screen' })).toBeVisible();
  await expect(lockScreen(page)).toHaveCount(0);

  // The tablet does: raising it again shows its lock screen, with no home screen behind it.
  await switchTo(page, 'tablet');
  await expect(lockScreen(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Home Screen' })).toHaveCount(0);

  // A wrong passcode is refused and the screen stays up.
  for (const digit of '1111')
    await lockScreen(page).getByRole('button', { name: digit, exact: true }).click();
  await lockScreen(page).getByRole('button', { name: 'Unlock' }).click();
  await expect(lockScreen(page).getByText('Incorrect passcode')).toBeVisible();
  await expect(lockScreen(page)).toBeVisible();

  // The right one opens it.
  for (const digit of PASSCODE)
    await lockScreen(page).getByRole('button', { name: digit, exact: true }).click();
  await lockScreen(page).getByRole('button', { name: 'Unlock' }).click();
  await expect(lockScreen(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Home Screen' })).toBeVisible();
});
