import type { FrameLocator, Page } from '@playwright/test';
import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { addOnFrame, dismissToasts, installAddOn } from '../support/addon';

/**
 * Spark (MICA-255), end to end against the browser mock.
 *
 * Fixture, from `mocks/spark.ts`: the player's Spark account (30, "Ada") has no profile, so the
 * app opens on the editor. Maya (profile 3) has already liked the player, so liking her is a
 * match and leaves one message from her. Jordan (profile 2) is neutral. Casey (profile 1) is
 * blocked by the player and is never dealt. Once the player opts in the deck is Maya, then Jordan.
 *
 * Reached through the Store like any `core: false` add-on, so the sandboxed frame is the one
 * under test. Nothing here asserts a colour: that is `e2eThemeCoverage`'s rule.
 */
const OPENER = 'hey! glad you liked me back 😊';

test.describe('Spark', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['store', 'admin']);
    await page.goto('/');
    await installAddOn(page, 'Spark');
    await page.getByRole('button', { name: /Spark/ }).click();
    // The install toast covers the top strip of the frame and swallows clicks — `dismissToasts`.
    await dismissToasts(page);
  });

  const card = (frame: FrameLocator, id: number) =>
    frame.locator(`[data-testid="spark-card"][data-profile-id="${id}"]`);

  /** Fill the editor with a valid profile and one gallery photo, then save. */
  const optIn = async (frame: FrameLocator, name = 'Ada') => {
    await expect(frame.getByTestId('spark-editor')).toBeVisible();
    await frame.getByTestId('spark-name').fill(name);
    await frame.getByTestId('spark-age').fill('29');
    await frame.getByTestId('spark-bio').fill('Night shifts and good coffee.');
    await frame.getByTestId('spark-add-photo').click();
    const picker = frame.getByRole('dialog', { name: 'Choose photos' });
    await expect(picker).toBeVisible();
    await picker.locator('.grid button').first().click();
    await picker.getByRole('button', { name: /^Done/ }).click();
    await expect(picker).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Remove photo' })).toHaveCount(1);
    await frame.getByTestId('spark-save').click();
    await expect(frame.getByTestId('spark-editor')).toHaveCount(0);
  };

  /** Opted in and looking at Maya. */
  const optInToDeck = async (frame: FrameLocator) => {
    await optIn(frame);
    await expect(frame.getByTestId('spark-card')).toHaveCount(1);
    await expect(card(frame, 3)).toBeVisible();
  };

  /** Like Maya, past the matched screen, to the Matches tab. */
  const matchWithMaya = async (frame: FrameLocator) => {
    await optInToDeck(frame);
    await frame.getByTestId('spark-like').click();
    await expect(frame.getByTestId('spark-matched')).toBeVisible();
    await frame.getByTestId('spark-keep-swiping').click();
    await expect(frame.getByTestId('spark-matched')).toHaveCount(0);
    await frame.getByRole('button', { name: 'Matches', exact: true }).click();
    await expect(frame.getByTestId('spark-match')).toHaveCount(1);
  };

  const openMayaThread = async (frame: FrameLocator) => {
    await frame.getByTestId('spark-match').click();
    await expect(frame.getByTestId('dm-message')).toHaveCount(1);
  };

  const openMenu = async (frame: FrameLocator) => {
    await frame.getByTestId('spark-match-actions').click();
    await expect(frame.getByTestId('spark-match-menu')).toBeVisible();
  };

  const reopenSpark = async (page: Page) => {
    await page.locator("button[aria-label='Return to home screen']").click();
    await page.getByRole('button', { name: /Spark/ }).click();
    await dismissToasts(page);
  };

  /** Admin's pending queue: one "Remove for everyone" per outstanding report. */
  const pendingReports = async (page: Page) => {
    await page.locator("button[aria-label='Return to home screen']").click();
    await page.getByRole('button', { name: /Admin/i }).first().click();
    await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();
    return page.getByRole('button', { name: 'Remove for everyone' });
  };

  test('opens on the editor with an age hint; under 18 or no photo cannot be saved', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'spark');
    await expect(frame.getByTestId('spark-editor')).toBeVisible();
    await expect(frame.getByTestId('spark-deck')).toHaveCount(0);
    await expect(frame.getByTestId('spark-age-hint')).toBeVisible();
    await expect(frame.getByTestId('spark-age-hint')).toContainText('18 or over');
    await expect(frame.getByTestId('spark-save')).toBeDisabled();

    await frame.getByTestId('spark-name').fill('Ada');
    await frame.getByTestId('spark-age').fill('29');
    // A name and an age are not enough: no photo, no profile.
    await expect(frame.getByTestId('spark-save')).toBeDisabled();

    await frame.getByTestId('spark-add-photo').click();
    const picker = frame.getByRole('dialog', { name: 'Choose photos' });
    await picker.locator('.grid button').first().click();
    await picker.getByRole('button', { name: /^Done/ }).click();
    await expect(frame.getByTestId('spark-save')).toBeEnabled();

    // With a photo, 17 is still refused, and the hint says so.
    await frame.getByTestId('spark-age').fill('17');
    await expect(frame.getByTestId('spark-age-hint')).toContainText('18 to 99');
    await expect(frame.getByTestId('spark-save')).toBeDisabled();
    await frame.getByTestId('spark-age').fill('18');
    await expect(frame.getByTestId('spark-save')).toBeEnabled();
  });

  test('a valid save lands on the deck with Maya first and never Casey', async ({ page }) => {
    const frame = addOnFrame(page, 'spark');
    await optInToDeck(frame);
    await expect(frame.getByTestId('spark-card-name')).toHaveText('Maya, 25');
    await expect(card(frame, 1)).toHaveCount(0);
    await expect(frame.getByText('Casey')).toHaveCount(0);
  });

  test('a pass removes the profile; a like on Jordan is no match and says nothing', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'spark');
    await optInToDeck(frame);

    await frame.getByTestId('spark-pass').click();
    await expect(card(frame, 3)).toHaveCount(0);
    await expect(card(frame, 2)).toBeVisible();
    await expect(frame.getByTestId('spark-card-name')).toHaveText('Jordan, 31');

    await frame.getByTestId('spark-like').click();
    await expect(frame.getByTestId('spark-deck-empty')).toBeVisible();
    // Nothing about whether he liked back: no matched screen, no match, no hint of either.
    await expect(frame.getByTestId('spark-matched')).toHaveCount(0);
    await frame.getByRole('button', { name: 'Matches', exact: true }).click();
    await expect(frame.getByText('No matches yet')).toBeVisible();
    await expect(frame.getByTestId('spark-match')).toHaveCount(0);
  });

  test('a like on Maya matches; the thread has her line and a reply appears once', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'spark');
    await optInToDeck(frame);
    await frame.getByTestId('spark-like').click();
    await expect(frame.getByTestId('spark-matched')).toBeVisible();
    await expect(frame.getByTestId('spark-matched')).toContainText('Maya');
    await frame.getByTestId('spark-keep-swiping').click();

    await frame.getByRole('button', { name: 'Matches', exact: true }).click();
    const row = frame.getByTestId('spark-match');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Maya');
    await expect(row).toContainText(OPENER);
    await expect(row.getByTestId('spark-match-unread')).toHaveText('1');

    await row.click();
    await expect(frame.getByTestId('dm-message')).toHaveCount(1);
    const theirs = frame.getByTestId('dm-message').first();
    await expect(theirs).toContainText(OPENER);
    await expect(theirs).toHaveAttribute('data-mine', 'false');

    const text = 'coffee on friday?';
    await frame.getByPlaceholder('Message Maya').fill(text);
    await frame.getByRole('button', { name: 'Send', exact: true }).click();

    // The send's own answer and the app-event push both carry this line; the store merges by id.
    await expect(frame.getByTestId('dm-message')).toHaveCount(2);
    const sent = frame.getByTestId('dm-message').filter({ hasText: text });
    await expect(sent).toHaveCount(1);
    await expect(sent).toHaveAttribute('data-mine', 'true');
    await expect(frame.getByPlaceholder('Message Maya')).toHaveValue('');
  });

  test('a matched or swiped profile is not dealt again, even after reopening', async ({ page }) => {
    const frame = addOnFrame(page, 'spark');
    await optInToDeck(frame);
    await frame.getByTestId('spark-like').click();
    await frame.getByTestId('spark-keep-swiping').click();
    // Maya is matched, so the next card is Jordan and Maya is gone.
    await expect(card(frame, 2)).toBeVisible();
    await expect(card(frame, 3)).toHaveCount(0);
    await frame.getByTestId('spark-pass').click();
    await expect(frame.getByTestId('spark-deck-empty')).toBeVisible();

    await reopenSpark(page);
    await expect(frame.getByTestId('spark-deck-empty')).toBeVisible();
    await expect(frame.getByTestId('spark-card')).toHaveCount(0);
  });

  test('unmatching removes the match and its thread', async ({ page }) => {
    const frame = addOnFrame(page, 'spark');
    await matchWithMaya(frame);
    await openMayaThread(frame);

    await openMenu(frame);
    await frame.getByTestId('spark-unmatch').click();
    await frame.getByRole('button', { name: 'Unmatch', exact: true }).click();

    await expect(frame.getByTestId('dm-thread')).toHaveCount(0);
    await expect(frame.getByTestId('spark-match')).toHaveCount(0);
    await expect(frame.getByText('No matches yet')).toBeVisible();
  });

  test('blocking from the match menu removes the match', async ({ page }) => {
    const frame = addOnFrame(page, 'spark');
    await matchWithMaya(frame);
    await openMayaThread(frame);

    await openMenu(frame);
    await frame.getByTestId('spark-block').click();
    await frame.getByRole('button', { name: 'Block', exact: true }).click();

    await expect(frame.getByTestId('dm-thread')).toHaveCount(0);
    await expect(frame.getByTestId('spark-match')).toHaveCount(0);
    await expect(frame.getByText('No matches yet')).toBeVisible();
  });

  test('a profile on the deck can be reported, and Admin queues it', async ({ page }) => {
    const frame = addOnFrame(page, 'spark');
    await optInToDeck(frame);

    await card(frame, 3).getByRole('button', { name: 'Report profile' }).click();
    await expect(frame.locator('text=Report content')).toBeVisible();
    await frame.getByRole('button', { name: 'Report', exact: true }).click();
    await expect(page.getByText('Report sent for review')).toBeVisible();

    // The seeded report plus this one.
    await expect(await pendingReports(page)).toHaveCount(2);
  });

  test("a match's message can be reported, and Admin queues it", async ({ page }) => {
    const frame = addOnFrame(page, 'spark');
    await matchWithMaya(frame);
    await openMayaThread(frame);

    await frame
      .getByTestId('dm-message')
      .first()
      .getByRole('button', { name: 'Report message' })
      .click();
    await expect(frame.locator('text=Report content')).toBeVisible();
    await frame.getByRole('button', { name: 'Report', exact: true }).click();
    await expect(page.getByText('Report sent for review')).toBeVisible();

    await expect(await pendingReports(page)).toHaveCount(2);
  });

  test('editing the profile renames it; deleting returns to the editor and drops the rest', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'spark');
    await matchWithMaya(frame);
    await frame.getByRole('button', { name: 'Discover', exact: true }).click();

    await frame.getByTestId('spark-edit-profile').click();
    await expect(frame.getByTestId('spark-name')).toHaveValue('Ada');
    await frame.getByTestId('spark-name').fill('Adaline');
    await frame.getByTestId('spark-save').click();
    await expect(frame.getByTestId('spark-editor')).toHaveCount(0);
    // The "Profile saved" toast sits over the header strip and swallows the click — `dismissToasts`.
    await expect(page.getByText('Profile saved')).toBeVisible();
    await dismissToasts(page);
    await frame.getByTestId('spark-edit-profile').click();
    await expect(frame.getByTestId('spark-name')).toHaveValue('Adaline');

    await frame.getByTestId('spark-delete-profile').click();
    await frame.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(frame.getByTestId('spark-editor')).toBeVisible();
    await expect(frame.getByTestId('spark-name')).toHaveValue('');
    await expect(frame.getByTestId('spark-deck')).toHaveCount(0);
    await expect(frame.getByTestId('spark-matches')).toHaveCount(0);
    await expect(frame.getByTestId('spark-match')).toHaveCount(0);
  });

  test('no card or thread ever shows a citizenid or an @handle', async ({ page }) => {
    const frame = addOnFrame(page, 'spark');
    await optInToDeck(frame);
    const leak = /@|spark_\d|citizen/i;

    await expect(card(frame, 3)).toContainText('Maya');
    await expect(card(frame, 3)).not.toContainText(leak);
    await expect(frame.getByTestId('spark-deck')).not.toContainText(leak);

    await frame.getByTestId('spark-like').click();
    await frame.getByTestId('spark-keep-swiping').click();
    await frame.getByRole('button', { name: 'Matches', exact: true }).click();
    await expect(frame.getByTestId('spark-matches')).not.toContainText(leak);
    await openMayaThread(frame);
    await expect(frame.getByTestId('dm-thread')).toContainText(OPENER);
    await expect(frame.getByTestId('dm-thread')).not.toContainText(leak);

    await openMenu(frame);
    await frame.getByTestId('spark-view-profile').click();
    await expect(card(frame, 3)).toBeVisible();
    await expect(card(frame, 3)).not.toContainText(leak);
  });
});
