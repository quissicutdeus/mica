import { test, expect, type FrameLocator } from '../support/test';
import { seedHomeGrid } from '../support/homeGrid';
import { addOnFrame, installAddOn, openInstalledApp } from '../support/addon';

/**
 * Snek, end to end against the browser mock (MICA-59).
 *
 * `core: false`, so it is installed through the Store first and driven inside its sandboxed
 * iframe, the same as Hodlr.
 *
 * `game.test.ts` already owns the rules — movement, growth, collision, scoring — so nothing
 * here re-asserts them. What only an e2e can reach is the shell integration around them:
 * that the loop is really running on its own timer, that WASD entering a sandboxed frame
 * reaches the board, that a finished game submits its score and persists a personal best
 * through the SDK's storage facet, and that the leaderboard reads back through the host.
 */
test.describe('Snek', () => {
  const GRID = 16;

  interface Snapshot {
    head: { x: number; y: number } | null;
    food: { x: number; y: number } | null;
    score: number;
    over: boolean;
  }

  /**
   * One read of everything the autopilot below decides on, in a single round trip.
   *
   * Off the cell classes rather than a test id, because that is all the board renders: the
   * head is the only `bg-yellow-500` cell and the food the only `bg-red-500` one. Food
   * parked off-grid (`placeFood`'s full-board fallback) reports as absent, which is exactly
   * how it should be treated.
   */
  const readGame = (frame: FrameLocator): Promise<Snapshot> =>
    frame.locator('body').evaluate((body, width) => {
      const board = body.querySelector('div.gap-px');
      const cells = board ? Array.from(board.children) : [];
      const at = (cls: string) => {
        const index = cells.findIndex((cell) => cell.classList.contains(cls));
        return index < 0 ? null : { x: index % width, y: Math.floor(index / width) };
      };
      const text = body.innerText;
      const score = text.match(/Score:\s*(\d+)/);
      return {
        head: at('bg-yellow-500'),
        food: at('bg-red-500'),
        score: score ? Number(score[1]) : 0,
        over: text.includes('Game Over')
      };
    }, GRID);

  /**
   * Play until something is eaten, and answer with the score (0 if the snake died first).
   *
   * Greedy: close the axis that is out of line with the food, re-deciding off a fresh read
   * of the board every time rather than off any assumption about when a tick lands. Nothing
   * here sleeps — a fixed wait against the game's own `tickMs` is the shape of race
   * MICA-34 was, and this loop's whole job is to be late-tolerant. Overshooting a turn
   * costs an approach, not the game: the snake is one segment long until it eats, and
   * `queueDirection` only refuses a reversal at length two or more.
   *
   * A key is sent only when the decision changes, so this is a few presses per approach
   * rather than one per poll.
   */
  const playUntilFed = async (frame: FrameLocator): Promise<number> => {
    const deadline = Date.now() + 15_000;
    let lastKey = '';
    while (Date.now() < deadline) {
      const game = await readGame(frame);
      if (game.score > 0) return game.score;
      if (game.over) return 0;
      if (!game.head || !game.food) continue;
      const key =
        game.head.x !== game.food.x
          ? game.food.x > game.head.x
            ? 'd'
            : 'a'
          : game.food.y > game.head.y
            ? 's'
            : 'w';
      if (key !== lastKey) {
        // Into the frame's own document: `Board.svelte` listens on `svelte:window`, and the
        // add-on's window is not the shell's.
        await frame.locator('body').press(key);
        lastKey = key;
      }
    }
    return 0;
  };

  test.beforeEach(async ({ page }) => {
    // The real home grid starts empty (MICA-5); Store has to already be placed there to
    // reach the install path.
    await seedHomeGrid(page, ['store']);
    await page.goto('/');
    await installAddOn(page, 'Snek');
    await openInstalledApp(page, 'Snek');
    // `.first()`: the header's title and the title screen's own headline are both `h1 Snek`.
    await expect(addOnFrame(page, 'snek').locator('h1', { hasText: 'Snek' }).first()).toBeVisible();
  });

  test('plays a game, scores, and keeps the score as a personal best', async ({ page }) => {
    // Above the suite default: a game is played at 220ms a tick against a randomly placed
    // food, and a died-before-eating attempt is retried rather than failed — three
    // approaches of at most 15s, then the unsteered run into a wall.
    test.setTimeout(90_000);
    const frame = addOnFrame(page, 'snek');

    // Easy — the slowest tick, so the autopilot has the most slack per decision.
    await frame.getByRole('button', { name: 'Easy' }).click();
    await expect(frame.getByText('Score: 0')).toBeVisible();

    let score = 0;
    for (let attempt = 0; attempt < 3 && score === 0; attempt += 1) {
      if (attempt > 0) await frame.getByRole('button', { name: 'Play Again' }).click();
      score = await playUntilFed(frame);
    }
    // The point of the whole spec: the loop ran on its own timer, keys crossed into the
    // sandboxed frame, and eating registered a score. Every one of those is invisible to
    // `game.test.ts`, which calls `tick` directly.
    expect(score).toBeGreaterThan(0);

    // Steering stops here, so the snake runs on in a straight line and hits a wall — the
    // game ending by itself is the loop still running without any input.
    // The modal's own heading, not the `Screen` header — `useAppLevels` retitles the
    // header to "Game Over" too, so a bare text match hits both.
    await expect(frame.locator('h2', { hasText: 'Game Over' })).toBeVisible({ timeout: 20_000 });
    const finalScore = (await readGame(frame)).score;
    expect(finalScore).toBeGreaterThanOrEqual(score);
    await expect(frame.getByText('New high score!')).toBeVisible();

    // Back to the title screen, where the best is read from the SDK's persisted store
    // rather than from the finished game's own state.
    await frame.getByRole('button', { name: 'Go back' }).click();
    await expect(frame.getByText(`Best: ${finalScore}`)).toBeVisible();
  });

  test('reads the shared leaderboard back through the host', async ({ page }) => {
    const frame = addOnFrame(page, 'snek');
    await frame.getByRole('button', { name: 'Leaderboard' }).click();

    /**
     * The rows are `getHighscoreLeaderboard`'s fixture, and the mock is deliberately
     * stateless — a score submitted this session does not come back in it — so what this
     * asserts is the read crossing the iframe boundary and rendering ranked, not a round
     * trip of your own score. Ranking is the app's own doing: the service answers rows,
     * and the numbering beside them is `Leaderboard.svelte`.
     */
    await expect(frame.getByText('1. Ada')).toBeVisible();
    await expect(frame.getByText('42', { exact: true })).toBeVisible();
    await expect(frame.getByText('2. Dez')).toBeVisible();
    await expect(frame.getByText('17', { exact: true })).toBeVisible();
  });
});
