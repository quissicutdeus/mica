import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, settledFrameBox } from '../support/device';
import { DEVICES } from '@mica/shared/devices';

/**
 * Settings on the tablet is two panes (MICA-261): the sections on the left, the selected
 * one on the right, both on screen at once — never the phone's drill-in. The phone's
 * `apps/settings.spec.ts` covers the panes themselves; this covers the tablet root's own
 * decisions: which pane opens by default, that a phone-only section is absent, and that
 * the Home Screen Grid stepper is bounded by the *tablet's* launcher range rather than the
 * phone's.
 */
const TABLET_COLUMNS = DEVICES.tablet.launcher.columnRange;
const TABLET_ROWS = DEVICES.tablet.launcher.rowRange;

test.describe('Settings on the tablet', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['settings'], 'tablet');
    await gotoDevice(page, 'tablet');
    await settledFrameBox(page, 'tablet');
    await page
      .getByRole('button', { name: /Settings/i })
      .first()
      .click();
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
  });

  test('opens on Display, with the sidebar and the pane both on screen', async ({ page }) => {
    const sidebar = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(sidebar).toBeVisible();
    // Not `exact: true` — the row's accessible name is its title *and* its subtitle,
    // both text inside the one button (`tablet.svelte`'s `sidebarRow` snippet).
    await expect(sidebar.getByRole('button', { name: /^Display/ })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(page.getByText('Home Screen Grid')).toBeVisible();

    // The frame picker is a phone-only decision — every tablet ships one body — so the
    // tablet root never renders it, on Display or anywhere else.
    await expect(page.getByTestId('frame-picker')).toHaveCount(0);

    // MICA-267: the Display subtitle used to read "...phone size and clock" on every
    // device. It is device-neutral now — a tablet reader should never see the word.
    const subtitle = await sidebar.getByRole('button', { name: /^Display/ }).innerText();
    expect(subtitle.toLowerCase()).not.toContain('phone');
  });

  test('the home grid stepper is bounded by the tablet launcher range, not the phone', async ({
    page
  }) => {
    const columnsCount = page.getByText(String(DEVICES.tablet.launcher.columns), { exact: true });
    await expect(columnsCount).toBeVisible();

    const moreColumns = page.getByRole('button', { name: 'More columns' });
    const fewerColumns = page.getByRole('button', { name: 'Fewer columns' });
    for (let i = DEVICES.tablet.launcher.columns; i < TABLET_COLUMNS[1]; i++) {
      await moreColumns.click();
    }
    await expect(page.getByText(String(TABLET_COLUMNS[1]), { exact: true })).toBeVisible();
    await expect(moreColumns).toBeDisabled();

    for (let i = TABLET_COLUMNS[1]; i > TABLET_COLUMNS[0]; i--) {
      await fewerColumns.click();
    }
    await expect(page.getByText(String(TABLET_COLUMNS[0]), { exact: true })).toBeVisible();
    await expect(fewerColumns).toBeDisabled();

    const moreRows = page.getByRole('button', { name: 'More rows' });
    const fewerRows = page.getByRole('button', { name: 'Fewer rows' });
    for (let i = DEVICES.tablet.launcher.rows; i < TABLET_ROWS[1]; i++) {
      await moreRows.click();
    }
    await expect(moreRows).toBeDisabled();
    for (let i = TABLET_ROWS[1]; i > TABLET_ROWS[0]; i--) {
      await fewerRows.click();
    }
    await expect(fewerRows).toBeDisabled();
  });

  test('the sidebar stays on screen while a different section is open', async ({ page }) => {
    const sidebar = page.getByRole('navigation', { name: 'Settings sections' });
    await sidebar.getByRole('button', { name: /^Sound/ }).click();
    await expect(sidebar.getByRole('button', { name: /^Sound/ })).toHaveAttribute(
      'aria-current',
      'page'
    );
    // Two panes, not a drill-in: the list that was just clicked is still there beside
    // whatever it opened.
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole('button', { name: /^Display/ })).toBeVisible();

    // Side volume buttons are phone hardware (MICA-267) — the tablet has none, so the
    // whole "Volume Buttons" section is absent rather than a hint about a control that
    // isn't there, the same choice already made for the phone-only frame picker above.
    await expect(page.getByText('Volume Buttons')).toHaveCount(0);
  });

  test("the Shortcuts footer names this device's own open/close key, not the phone's", async ({
    page
  }) => {
    // MICA-267: the footer used to hard-code "Open Phone" regardless of which device it
    // was read on. It now reads off `DEVICES[device].keybind`, so on the tablet it should
    // name `openTablet`'s label and never the phone's.
    const sidebar = page.getByRole('navigation', { name: 'Settings sections' });
    await sidebar.getByRole('button', { name: /^Shortcuts/ }).click();
    await expect(page.getByText('Open Tablet is bound')).toBeVisible();
    await expect(page.getByText('Open Phone is bound')).toHaveCount(0);
  });
});
