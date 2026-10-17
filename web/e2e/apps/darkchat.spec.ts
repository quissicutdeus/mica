import type { FrameLocator, Page } from '@playwright/test';
import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { gotoDevice, settledFrameBox } from '../support/device';
import { addOnFrame, dismissToasts, installAddOn } from '../support/addon';

/**
 * Dark Chat (MICA-254), end to end against the browser mock.
 *
 * Fixture, from `mocks/darkchat.ts`: one channel, "Night Market" (id 1, code K7QX2MPV), owned
 * by the alias `vandal`. Its members are vandal, nightowl and the player as `ghost` — who is
 * NOT the owner, so every owner-only control is absent there and present only in a channel the
 * player creates. Four lines: 1 vandal, 2 a bot ("Lookout"), 3 nightowl, 4 the player's own.
 *
 * Reached through the Store like any `core: false` add-on, so the sandboxed frame is the one
 * under test, not an in-process stand-in.
 */
const SEED_CODE = 'K7QX2MPV';
const CODE_SHAPE = /^[A-Z2-9]{8}$/;

test.describe('Dark Chat', () => {
  test.beforeEach(async ({ page }) => {
    await seedHomeGrid(page, ['store', 'admin']);
    await page.goto('/');
    await installAddOn(page, 'Dark Chat');
    await page.getByRole('button', { name: /Dark Chat/ }).click();
    // The install toast covers the top strip of the frame and swallows clicks — `dismissToasts`.
    await dismissToasts(page);
  });

  const message = (frame: FrameLocator, id: number) =>
    frame.locator(`[data-testid="darkchat-message"][data-message-id="${id}"]`);

  /** From the channel list into Night Market's thread, waiting for its lines. */
  const openNightMarket = async (frame: FrameLocator) => {
    await frame.getByTestId('darkchat-channel').filter({ hasText: 'Night Market' }).click();
    await expect(frame.getByTestId('darkchat-message')).toHaveCount(4);
  };

  /** From an open thread to its info screen. */
  const openInfo = async (frame: FrameLocator) => {
    await frame.getByTestId('darkchat-info').click();
    await expect(frame.getByTestId('darkchat-members')).toBeVisible();
  };

  /** Leave the open channel through its info screen and the confirmation. */
  const leaveOpenChannel = async (frame: FrameLocator) => {
    await openInfo(frame);
    await frame.getByRole('button', { name: 'Leave channel', exact: true }).click();
    await frame.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(frame.getByTestId('darkchat-channels')).toBeVisible();
  };

  /** Fill the create form and submit it; lands on the one-time code screen. */
  const createChannel = async (frame: FrameLocator, name: string, alias: string) => {
    await frame.getByRole('button', { name: 'Create', exact: true }).click();
    await frame.getByTestId('darkchat-name').fill(name);
    await frame.getByTestId('darkchat-alias').fill(alias);
    await frame.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(frame.getByTestId('darkchat-code')).toBeVisible();
  };

  const openJoinForm = async (frame: FrameLocator, code: string, alias: string) => {
    await frame.getByRole('button', { name: 'Join', exact: true }).click();
    await frame.getByTestId('darkchat-join-code').fill(code);
    await frame.getByTestId('darkchat-alias').fill(alias);
  };

  test('lists the seeded channel and opens its thread, bot line badged and my line marked', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'darkchat');
    const rows = frame.getByTestId('darkchat-channel');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Night Market');
    await expect(rows.first()).toContainText('You go by ghost here.');

    await openNightMarket(frame);

    // Exactly one line is mine, and it is the player's own (4); exactly one is a bot's (2).
    await expect(frame.locator('[data-testid="darkchat-message"][data-mine="true"]')).toHaveCount(
      1
    );
    await expect(message(frame, 4)).toHaveAttribute('data-mine', 'true');
    await expect(message(frame, 4)).toContainText('On my way.');

    await expect(frame.locator('[data-testid="darkchat-message"][data-bot="true"]')).toHaveCount(1);
    const bot = message(frame, 2);
    await expect(bot).toContainText('Patrols doubled on Grove Street tonight.');
    await expect(bot).toContainText('Lookout');
    await expect(bot.getByTestId('darkchat-bot-badge')).toBeVisible();
    // The badge belongs to the script alone.
    await expect(frame.getByTestId('darkchat-bot-badge')).toHaveCount(1);
    await expect(message(frame, 3)).toHaveAttribute('data-bot', 'false');
    await expect(message(frame, 3)).toHaveAttribute('data-mine', 'false');
  });

  test('a sent message appears exactly once', async ({ page }) => {
    const frame = addOnFrame(page, 'darkchat');
    await openNightMarket(frame);

    const text = 'meet at the docks';
    await frame.getByPlaceholder('Message as ghost').fill(text);
    await frame.getByRole('button', { name: 'Send', exact: true }).click();

    // The send's own answer and the app-event push both carry this line; the store merges by id.
    await expect(frame.getByTestId('darkchat-message')).toHaveCount(5);
    const sent = frame.getByTestId('darkchat-message').filter({ hasText: text });
    await expect(sent).toHaveCount(1);
    await expect(sent).toHaveAttribute('data-mine', 'true');
    await expect(frame.getByPlaceholder('Message as ghost')).toHaveValue('');
  });

  test('creating a channel shows an eight-character code, and its owner can rotate it', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'darkchat');
    await createChannel(frame, 'Back Alley', 'shade');

    const created = frame.getByTestId('darkchat-code');
    await expect(created).toHaveText(CODE_SHAPE);
    const first = (await created.textContent())!.trim();

    await frame.getByRole('button', { name: 'Done', exact: true }).click();
    // Past the code screen, in the new channel's (empty) thread as its owner.
    await expect(frame.getByPlaceholder('Message as shade')).toBeVisible();
    await expect(frame.getByTestId('darkchat-message')).toHaveCount(0);

    await openInfo(frame);
    await expect(frame.getByTestId('darkchat-code')).toHaveCount(0);
    await frame.getByRole('button', { name: 'Show code', exact: true }).click();
    await expect(frame.getByTestId('darkchat-code')).toHaveText(first);

    await frame.getByRole('button', { name: 'New code', exact: true }).click();
    await frame.getByRole('button', { name: 'Replace', exact: true }).click();
    const code = frame.getByTestId('darkchat-code');
    await expect(code).not.toHaveText(first);
    await expect(code).toHaveText(CODE_SHAPE);
    // Rotating changed the code and nothing else: I am still the one member.
    await expect(frame.getByTestId('darkchat-members').locator('li')).toHaveCount(1);
  });

  test('a code that does not exist is refused without saying why', async ({ page }) => {
    const frame = addOnFrame(page, 'darkchat');
    await openJoinForm(frame, 'ZZZZZZZZ', 'intruder');
    await frame.getByRole('button', { name: 'Join', exact: true }).click();

    await expect(page.getByText('That code did not work.')).toBeVisible();
    // Still on the form, and no channel was added behind the refusal.
    await expect(frame.getByTestId('darkchat-join-code')).toBeVisible();
  });

  test('a good code and an alias join the channel, as a new identity', async ({ page }) => {
    const frame = addOnFrame(page, 'darkchat');
    // The seed already has the player in Night Market, which a join would refuse; leave first.
    await openNightMarket(frame);
    await leaveOpenChannel(frame);
    await expect(frame.getByTestId('darkchat-channel')).toHaveCount(0);

    await openJoinForm(frame, SEED_CODE, 'newbie');
    await frame.getByRole('button', { name: 'Join', exact: true }).click();

    // Straight into the thread, under the alias just chosen.
    await expect(frame.getByPlaceholder('Message as newbie')).toBeVisible();
    await expect(frame.getByTestId('darkchat-message')).toHaveCount(4);
    // A rejoin is a new member, so the old `ghost` line is no longer mine.
    await expect(message(frame, 4)).toHaveAttribute('data-mine', 'false');
    await expect(frame.locator('[data-testid="darkchat-message"][data-mine="true"]')).toHaveCount(
      0
    );
  });

  test('a member who is not the owner sees no code, rotate or remove controls', async ({
    page
  }) => {
    const frame = addOnFrame(page, 'darkchat');
    await openNightMarket(frame);
    await openInfo(frame);

    const members = frame.getByTestId('darkchat-members').locator('li');
    await expect(members).toHaveCount(3);
    await expect(members.filter({ hasText: 'ghost' })).toContainText('you');
    await expect(frame.getByRole('button', { name: 'Show code', exact: true })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'New code', exact: true })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await expect(frame.getByTestId('darkchat-code')).toHaveCount(0);
    // Leaving is everyone's.
    await expect(frame.getByRole('button', { name: 'Leave channel', exact: true })).toBeVisible();
  });

  test('leaving a channel removes it from the list', async ({ page }) => {
    const frame = addOnFrame(page, 'darkchat');
    await openNightMarket(frame);
    await leaveOpenChannel(frame);

    await expect(frame.getByTestId('darkchat-channel')).toHaveCount(0);
    await expect(frame.getByText('No channels yet')).toBeVisible();
  });

  test("reports somebody else's message, never my own or a bot's, and Admin sees my alias", async ({
    page
  }) => {
    const frame = addOnFrame(page, 'darkchat');
    await openNightMarket(frame);

    await expect(message(frame, 1).getByRole('button', { name: 'Report message' })).toHaveCount(1);
    await expect(message(frame, 3).getByRole('button', { name: 'Report message' })).toHaveCount(1);
    await expect(message(frame, 4).getByRole('button', { name: 'Report message' })).toHaveCount(0);
    await expect(message(frame, 2).getByRole('button', { name: 'Report message' })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Report message' })).toHaveCount(2);

    await message(frame, 1).getByRole('button', { name: 'Report message' }).click();
    await expect(frame.locator('text=Report content')).toBeVisible();
    await frame.getByRole('button', { name: 'Report', exact: true }).click();
    await expect(page.getByText('Report sent for review')).toBeVisible();

    await page.locator("button[aria-label='Return to home screen']").click();
    await page.getByRole('button', { name: /Admin/i }).first().click();
    await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();

    // The seeded report has no reporter label; ours is the only one that does.
    const label = page.getByTestId('admin-reporter-label');
    await expect(label).toHaveCount(1);
    await expect(label).toContainText('ghost');
    await expect(page.getByText('Usual spot after midnight.')).toBeVisible();
  });
});

test.describe('Admin names a report content author as the author', () => {
  const openAdmin = async (page: Page) => {
    await seedHomeGrid(page, ['admin'], 'tablet');
    await gotoDevice(page, 'tablet');
    await settledFrameBox(page, 'tablet');
    await page.getByRole('button', { name: /Admin/i }).first().click();
    await expect(page.locator('h1', { hasText: 'Admin' })).toBeVisible();
  };

  test('the tablet detail pane says who posted it, not who reported it', async ({ page }) => {
    await openAdmin(page);
    const detail = page.getByTestId('admin-detail');
    // The seeded report's content was written by AUTHOR1; the person who filed it is someone
    // else, and the old "Reported by" label put the author's name against the wrong role.
    await expect(detail.getByText('Posted by: AUTHOR1')).toBeVisible();
    await expect(detail.getByText(/Reported by/)).toHaveCount(0);
  });
});
