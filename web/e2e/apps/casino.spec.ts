import type { FrameLocator, Page } from '@playwright/test';
import { test, expect } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { addOnFrame, dismissToasts, installAddOn } from '../support/addon';

/**
 * Casino (MICA-82), end to end against the browser mock.
 *
 * Reached through the Store like any `core: false` add-on, so the sandboxed frame is the one
 * under test. Fixture, from `mocks/services/casino.ts`: a 25000 bank, bet_min 10, bet_max 5000,
 * and four seeded history rows (ids 1-4, page size 20).
 *
 * The mock draws every outcome from `Math.random` and has no seed or force hook, so each test
 * pins it with an init script — in the top document, where the mock lives; the sandboxed
 * frame never draws. Without that, a Crash round busts at its first tick about 3% of the time
 * and nearly 8% of the time by 1.05x, and a cash-out test would fail on chance alone, which
 * `retries: 0` turns into a red build.
 *
 * With `u = 1 - random`, the mock's crash point is `floor(97 / u)` (x100), so:
 *   random 0.999999 -> 1000.00x, a round that outlives any test;
 *   random 0.19     -> 1.19x, reached 10s * log2(1.19) = ~2.5s after the start.
 * Roulette's number is `floor(random * 37)`, so 0.5 -> 18 (red).
 */
const NEVER_BUSTS = 0.999999;
const BUSTS_AT_1_19 = 0.19;
const NUMBER_18 = 0.5;

const MULTIPLIER = /^(\d+)\.(\d{2})×$/;

test.describe('Casino', () => {
  const open = async (page: Page, random: number): Promise<FrameLocator> => {
    await page.addInitScript((value) => {
      Math.random = () => value;
    }, random);
    await seedHomeGrid(page, ['store', 'admin']);
    await page.goto('/');
    await installAddOn(page, 'Casino');
    await page.getByRole('button', { name: /Casino/ }).click();
    // The install toast covers the top strip of the frame and swallows clicks — `dismissToasts`.
    await dismissToasts(page);
    return addOnFrame(page, 'casino');
  };

  const reopen = async (page: Page) => {
    await page.locator("button[aria-label='Return to home screen']").click();
    await page.getByRole('button', { name: /Casino/ }).click();
    await dismissToasts(page);
  };

  /** The displayed multiplier as a number, or NaN while it reads something else. */
  const multiplierOf = async (frame: FrameLocator): Promise<number> => {
    const text = (await frame.getByTestId('casino-multiplier').textContent())?.trim() ?? '';
    const match = MULTIPLIER.exec(text);
    return match ? Number(`${match[1]}.${match[2]}`) : NaN;
  };

  const startCrash = async (frame: FrameLocator) => {
    await frame.getByRole('button', { name: 'Crash', exact: true }).click();
    await expect(frame.getByTestId('casino-stake')).toHaveValue('10');
    await frame.getByTestId('casino-crash-start').click();
    await expect(frame.getByTestId('casino-crash-cashout')).toBeVisible();
  };

  test('installs from the Store and opens on the roulette tab', async ({ page }) => {
    const frame = await open(page, NEVER_BUSTS);
    await expect(frame.getByRole('button', { name: 'Roulette', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(frame.getByRole('button', { name: 'Crash', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect(frame.getByTestId('casino-board')).toBeVisible();
    // The chip row is built from the mock's limits: it proves `config` arrived, and that the
    // smallest chip is the table minimum.
    await expect(frame.getByTestId('casino-chip').first()).toHaveAttribute('data-value', '10');
    await expect(frame.getByTestId('casino-spin')).toBeDisabled();
  });

  test('a red chip and a straight chip spin to a number whose net matches the stake', async ({
    page
  }) => {
    const frame = await open(page, NUMBER_18);
    await frame.getByTestId('casino-chip').first().click();
    await frame.getByTestId('casino-bet-red').click();
    await frame.getByTestId('casino-bet-straight-17').click();
    await expect(frame.getByText('Staked $20.00 of $5,000.00')).toBeVisible();

    await frame.getByTestId('casino-spin').click();
    const result = frame.getByTestId('casino-result');
    await expect(result).toBeVisible();

    // 18 is red: red returns 2 x 10, the straight on 17 loses, so 20 staked and 20 back.
    await expect(result).toContainText('18');
    await expect(result).toContainText('Broke even');
    // The board cleared once the server took the bets.
    await expect(frame.getByTestId('casino-spin')).toBeDisabled();
    await expect(frame.getByText('Staked $0.00 of $5,000.00')).toBeVisible();
  });

  test('a winning straight pays 35 to 1 on the stake', async ({ page }) => {
    // 17/37 = 0.4595; floor(0.46 * 37) = 17.
    const frame = await open(page, 0.46);
    await frame.getByTestId('casino-chip').first().click();
    await frame.getByTestId('casino-bet-straight-17').click();
    await frame.getByTestId('casino-spin').click();
    const result = frame.getByTestId('casino-result');
    await expect(result).toContainText('17');
    // 10 staked, 360 back: a net of 350.
    await expect(result).toContainText('Won $350.00');
  });

  test('a chip past bet_max is refused inline and placed nowhere', async ({ page }) => {
    const frame = await open(page, NEVER_BUSTS);
    const chips = frame.getByTestId('casino-chip');
    await expect(chips.last()).toHaveAttribute('data-value', '5000');
    await chips.last().click();
    await frame.getByTestId('casino-bet-red').click();
    await expect(frame.getByText('Staked $5,000.00 of $5,000.00')).toBeVisible();

    // One more chip would be 10000 on the table.
    await frame.getByTestId('casino-bet-straight-17').click();
    await expect(frame.getByText('Bets total at most $5,000.00.')).toBeVisible();
    await expect(frame.getByText('Staked $5,000.00 of $5,000.00')).toBeVisible();
  });

  test('Crash climbs, and a cash-out answers with a payout', async ({ page }) => {
    const frame = await open(page, NEVER_BUSTS);
    await startCrash(frame);

    const readings: number[] = [];
    await expect
      .poll(
        async () => {
          readings.push(await multiplierOf(frame));
          const first = readings.find((value) => !Number.isNaN(value));
          const last = readings[readings.length - 1];
          return first !== undefined && last > first;
        },
        { timeout: 10_000 }
      )
      .toBe(true);

    await frame.getByTestId('casino-crash-cashout').click();
    const result = frame.getByTestId('casino-crash-result');
    await expect(result).toContainText('Cashed out at');
    // A payout is a stake times a multiplier of at least 1.00, so at least the 10 staked.
    const paid = Number(/for \$(\d+)/.exec((await result.textContent()) ?? '')?.[1]);
    expect(paid).toBeGreaterThanOrEqual(10);
    await expect(frame.getByTestId('casino-crash-start')).toBeEnabled();
    await expect(frame.getByTestId('casino-crash-cashout')).toHaveCount(0);
  });

  test('a round that busts shows the crash and re-arms Start', async ({ page }) => {
    const frame = await open(page, BUSTS_AT_1_19);
    await startCrash(frame);

    // The mock's own timer pushes `casino:crash` at 1.19x, ~2.5s in.
    const result = frame.getByTestId('casino-crash-result');
    await expect(result).toContainText('Crashed at 1.19×', { timeout: 10_000 });
    await expect(result).toContainText('Lost $10.00');
    await expect(frame.getByTestId('casino-multiplier')).toHaveText('1.19×');
    await expect(frame.getByTestId('casino-crash-cashout')).toHaveCount(0);
    await expect(frame.getByTestId('casino-crash-start')).toBeEnabled();
  });

  test('a second start while a round is live is refused as round_active', async ({ page }) => {
    const frame = await open(page, NEVER_BUSTS);
    await startCrash(frame);

    // Start is not offered while a round is live, so the refused start needs a phone that has
    // lost track of it: the server's `crash` push for the live round (its id is on the
    // cash-out button) clears the app's round while the mock's real one keeps running — a
    // desynchronised client, the case `round_active` exists for.
    const roundId = Number(
      await frame.getByTestId('casino-crash-cashout').getAttribute('data-round-id')
    );
    expect(roundId).toBeGreaterThan(4);
    await page.evaluate(
      (id) => window.pushAppEvent?.('casino', 'crash', { round_id: id, crash_at: 150 }),
      roundId
    );
    await expect(frame.getByTestId('casino-crash-result')).toContainText('Crashed at 1.50×');
    await frame.getByTestId('casino-crash-start').click();
    await expect(page.getByText('Finish your crash round first.')).toBeVisible();
    await expect(frame.getByTestId('casino-crash-cashout')).toHaveCount(0);
    await expect(frame.getByTestId('casino-crash-start')).toBeEnabled();
  });

  test('history lists the seeded rounds', async ({ page }) => {
    const frame = await open(page, NEVER_BUSTS);
    await frame.getByRole('button', { name: 'History', exact: true }).click();
    const rows = frame.getByTestId('casino-history-row');
    await expect(rows).toHaveCount(4);
    // Newest first: round 4 is the busted crash at 1.12x, round 1 the roulette 17.
    await expect(rows.first()).toContainText('1.12×');
    await expect(rows.last()).toContainText('17');
    await expect(frame.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  });

  test('history pages past 20 rounds with Load more', async ({ page }) => {
    test.setTimeout(60_000);
    const frame = await open(page, NUMBER_18);
    // The mock seeds four rounds and pages by 20 with no way to seed more, so 17 spins
    // (each held ~900ms by the reveal) make the 21 that need a second page. Each bet cell is
    // disabled during the reveal, which is what paces the loop — no fixed wait.
    await frame.getByTestId('casino-chip').first().click();
    for (let spin = 0; spin < 17; spin += 1) {
      await frame.getByTestId('casino-bet-red').click();
      await frame.getByTestId('casino-spin').click();
    }
    await expect(frame.getByTestId('casino-result')).toBeVisible();

    await frame.getByRole('button', { name: 'History', exact: true }).click();
    const rows = frame.getByTestId('casino-history-row');
    await expect(rows).toHaveCount(20);
    await frame.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(21);
    await expect(frame.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  });

  test('reopening the app resumes a live round through crashState', async ({ page }) => {
    const frame = await open(page, NEVER_BUSTS);
    await startCrash(frame);
    const before = await multiplierOf(frame);
    expect(before).toBeGreaterThanOrEqual(1);

    await reopen(page);
    await frame.getByRole('button', { name: 'Crash', exact: true }).click();
    await expect(frame.getByTestId('casino-crash-cashout')).toBeVisible();
    // Still live and still climbing: it rose past what it read before leaving.
    await expect.poll(() => multiplierOf(frame), { timeout: 10_000 }).toBeGreaterThan(before);
    await expect(frame.getByTestId('casino-crash-start')).toHaveCount(0);
  });
});
