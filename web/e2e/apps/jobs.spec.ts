import { test, expect, type Page } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';

/**
 * One held job's card, found by the label a player reads rather than by `data-job`. The
 * `data-testid` narrows the search to cards, so a job label that also appears in a toast
 * or a line label elsewhere cannot match.
 */
const card = (page: Page, label: string) => page.getByTestId('job-card').filter({ hasText: label });

/**
 * The head of a card is the switch-to button, with `aria-pressed` saying whether this is
 * the active job (`JobCard.svelte`). Reading the attribute, not the border colour, is what
 * makes "active" mean what the app means by it.
 */
const head = (page: Page, label: string) => card(page, label).getByRole('button', { name: label });

test.describe('Jobs App E2E', () => {
  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Jobs has to already be placed there for
    // the click-by-name pattern to have anything to click.
    await seedHomeGrid(page, ['jobs']);
    await page.goto('/');
    await page.locator('button', { hasText: 'Jobs' }).first().click();
    await expect(page.locator('h1', { hasText: 'Jobs' })).toBeVisible();
  });

  test('lists every held job, with LSPD marked active', async ({ page }) => {
    // Three from `mockJobs`, none more: an extra card would be a fixture drift the count
    // is here to notice.
    await expect(page.getByTestId('job-card')).toHaveCount(3);
    await expect(card(page, 'LSPD')).toContainText('Grade 2 · Sergeant');
    await expect(card(page, 'Los Santos Customs')).toContainText('Grade 3 · Owner');
    await expect(card(page, 'Downtown Cab Co.')).toContainText('Grade 0 · Driver');

    // Active is a state, not a badge: the head button is pressed and has nothing to
    // switch to, so it is disabled. The other two are live.
    await expect(head(page, 'LSPD')).toHaveAttribute('aria-pressed', 'true');
    await expect(head(page, 'LSPD')).toBeDisabled();
    await expect(card(page, 'LSPD')).toContainText('Active');
    await expect(head(page, 'Los Santos Customs')).toHaveAttribute('aria-pressed', 'false');
    await expect(head(page, 'Los Santos Customs')).toBeEnabled();
    await expect(head(page, 'Downtown Cab Co.')).toHaveAttribute('aria-pressed', 'false');
  });

  /**
   * The mock's `setActiveJob` mutates the fixture the way `server/services/Jobs.ts` answers
   * with the new list, so this reads back a real state change, not a re-render of the same
   * data: the pressed card moves, and the old one becomes tappable again.
   */
  test('tapping Los Santos Customs makes it active and shows its society balance', async ({
    page
  }) => {
    await head(page, 'Los Santos Customs').click();

    await expect(head(page, 'Los Santos Customs')).toHaveAttribute('aria-pressed', 'true');
    await expect(head(page, 'Los Santos Customs')).toBeDisabled();
    await expect(head(page, 'LSPD')).toHaveAttribute('aria-pressed', 'false');
    await expect(head(page, 'LSPD')).toBeEnabled();
    // Exactly one card is active after the switch, so the state moved rather than doubled.
    await expect(page.getByRole('button', { pressed: true })).toHaveCount(1);

    // The society line renders `$` + `formatCurrency(48200)` on the mechanic card and on no
    // other — the fixture's only non-null balance.
    const lsc = card(page, 'Los Santos Customs');
    await expect(lsc).toContainText('Society balance');
    await expect(lsc).toContainText('$48,200.00');
    await expect(page.getByText('Society balance')).toHaveCount(1);
  });

  /**
   * The duty switch is a `role="switch"` whose accessible name is its label, so the label
   * flipping is what `getByRole` by name asserts. Both halves are checked — the new name
   * appears *and* the old one is gone — so a second switch appearing beside the first
   * would not pass as a flip.
   */
  test('the duty toggle on the active job flips its state and label', async ({ page }) => {
    const lspd = card(page, 'LSPD');
    const onDuty = lspd.getByRole('switch', { name: 'On duty' });
    await expect(onDuty).toBeEnabled();
    await expect(onDuty).toHaveAttribute('aria-checked', 'true');

    await onDuty.click();

    const offDuty = lspd.getByRole('switch', { name: 'Off duty' });
    await expect(offDuty).toHaveAttribute('aria-checked', 'false');
    await expect(lspd.getByRole('switch', { name: 'On duty' })).toHaveCount(0);

    // And back, so the toggle is a toggle and not a one-way latch.
    await offDuty.click();
    await expect(lspd.getByRole('switch', { name: 'On duty' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('an inactive job cannot clock in, and a job with no duty shows no switch', async ({
    page
  }) => {
    // LSC has a duty state but is not active: the switch is there, disabled, and says why.
    const lsc = card(page, 'Los Santos Customs');
    await expect(lsc.getByRole('switch')).toBeDisabled();
    await expect(lsc).toContainText('Switch to this job to clock in.');

    // Taxi's `onDuty` is `null` — the framework has no duty for it — so no switch at all.
    // The card is asserted present first, so an empty locator is a missing switch and not
    // a missing card.
    const taxi = card(page, 'Downtown Cab Co.');
    await expect(taxi).toBeVisible();
    await expect(taxi.getByRole('switch')).toHaveCount(0);
  });

  test('lists the line a script registered under Los Santos Customs', async ({ page }) => {
    const lsc = card(page, 'Los Santos Customs');
    await expect(lsc.getByText('LSC Front Desk')).toBeVisible();
    await expect(lsc.getByText('555-0142')).toBeVisible();
    await expect(lsc.getByText('Call', { exact: true })).toBeVisible();
    // The fixture registers exactly one line, on this job and no other.
    await expect(page.getByText('Call', { exact: true })).toHaveCount(1);
  });
});
