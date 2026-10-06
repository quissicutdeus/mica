import { test, expect, type Locator, type Page } from '../support/test';
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

/**
 * The button that opens a line's shared inbox (MICA-307), found by the name a screen reader
 * announces — the line's label and "911 · Inbox" — not by the row's test id, so the click
 * lands on the control and not on whatever sits at the row's centre.
 */
const inboxButton = (scope: Locator) => scope.getByRole('button', { name: /911 · Inbox/ });

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
    // Exactly one line on this card, and a plain one: no inbox behind its row. (A page-wide
    // count of Call buttons says nothing about this card — LSPD's 911 line has its own.)
    await expect(lsc.getByTestId('job-line')).toHaveCount(1);
    await expect(lsc.getByTestId('job-line')).toHaveAttribute('data-inbox', 'false');
    await expect(lsc.getByText('Call', { exact: true })).toHaveCount(1);
  });

  /**
   * A line with `inbox: true` is the only kind that opens a shared inbox (MICA-307). The
   * fixture gives LSPD one (911) and LSC a plain one; the 911 row names its inbox in place
   * of the bare number and keeps a Call button of its own.
   */
  test('only the 911 line offers an inbox, and it keeps its own Call button', async ({ page }) => {
    // Two lines across the three cards, of two kinds.
    await expect(page.getByTestId('job-line')).toHaveCount(2);
    await expect(page.locator('[data-testid="job-line"][data-inbox="true"]')).toHaveCount(1);

    const lspd = card(page, 'LSPD');
    await expect(lspd.getByTestId('job-line')).toHaveAttribute('data-inbox', 'true');
    await expect(lspd.getByText('Emergency')).toBeVisible();

    // Two controls, not one holding the other: the inbox button and the Call button are
    // siblings, and the inbox button contains no button of its own (axe's `nested-interactive`
    // is what a button inside a button costs a screen reader).
    const open = inboxButton(lspd);
    const call = lspd.getByRole('button', { name: 'Call', exact: true });
    await expect(open).toBeVisible();
    await expect(call).toBeVisible();
    await expect(open).not.toContainText('Call');
    await expect(open.getByRole('button')).toHaveCount(0);
    await expect(
      open.locator('xpath=following-sibling::button[normalize-space()="Call"]')
    ).toHaveCount(1);
  });

  /**
   * The staff side of a job line, end to end against the mock: open the inbox, see which
   * thread nobody has answered, read it, answer as the line, and see the list agree. The
   * mock's `lineReply` appends to its fixture the way the server's answer reads back, so
   * the last step is a real state change — the marker leaving 9101 — not a re-render.
   */
  test('911 inbox: read an unanswered thread, reply as the line, and it stops awaiting', async ({
    page
  }) => {
    const caller = 'Shots fired near the pier, two people running north';
    const answered = 'Units are on the way. Stay where you are.';

    await inboxButton(card(page, 'LSPD')).click();

    // The inbox is the 911 line's, titled with its label. Rows are told apart by their last
    // message, not by a caller name that waits on the contacts load.
    await expect(page.locator('h1', { hasText: 'Emergency' })).toBeVisible();
    const rows = page.getByTestId('line-thread-row');
    await expect(rows).toHaveCount(2);
    const unanswered = rows.filter({ hasText: caller });
    const done = rows.filter({ hasText: answered });
    await expect(unanswered).toHaveAttribute('data-awaiting', 'true');
    await expect(unanswered).toContainText('Awaiting reply');
    await expect(done).toHaveAttribute('data-awaiting', 'false');
    await expect(done).not.toContainText('Awaiting reply');
    await expect(page.getByText('Awaiting reply')).toHaveCount(1);

    // Open the unanswered one: the caller's message, on the caller's side, with the marker
    // that a photo came with it. The photo is named, never shown.
    await unanswered.click();
    const messages = page.getByTestId('line-message');
    await expect(messages).toHaveCount(1);
    await expect(messages.first()).toHaveAttribute('data-side', 'caller');
    await expect(messages.first()).toContainText(caller);
    await expect(messages.first()).toContainText('Photo sent');

    // Answer as the line; the composer names whose voice this is.
    const reply = 'Units dispatched to the pier. Are you safe?';
    const box = page.getByPlaceholder('Reply as Emergency');
    await box.fill(reply);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const sent = messages.filter({ hasText: reply });
    await expect(sent).toHaveCount(1);
    await expect(sent).toHaveAttribute('data-side', 'line');
    await expect(messages).toHaveCount(2);
    // A sent draft is cleared, so a second tap cannot send it twice.
    await expect(box).toHaveValue('');

    // Back to the inbox: nobody is awaited any more, and the row reads the answer.
    await page.locator("button[aria-label='Go back']").click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByText('Awaiting reply')).toHaveCount(0);
    const answeredNow = rows.filter({ hasText: reply });
    await expect(answeredNow).toHaveCount(1);
    await expect(answeredNow).toHaveAttribute('data-awaiting', 'false');
    await expect(rows.filter({ hasText: caller })).toHaveCount(0);
  });
});
