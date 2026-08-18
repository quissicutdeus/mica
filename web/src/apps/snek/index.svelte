<script lang="ts">
  import { Screen, useAppLevels, usePersisted, useHighscores, type AppProps } from '@gphone/sdk';
  import { createGame, tick, type GameState, type Difficulty, type Direction } from './game';
  import Board from './Board.svelte';
  import Hud from './Hud.svelte';
  import GameOverModal from './GameOverModal.svelte';
  import Leaderboard from './Leaderboard.svelte';

  // The annotation, not `$props<AppProps>()` — that form only works for an inline object
  // literal and reports "Expected 0 type arguments" for a named type.
  let { onback }: AppProps = $props();

  const { submitScore } = useHighscores();
  const highScore = usePersisted<number>('snek', 'highScore', 0);

  type ScreenName = 'title' | 'playing' | 'gameover' | 'leaderboard';
  let screen = $state<ScreenName>('title');
  /** Where the leaderboard's own back button returns to — it's reachable from two places. */
  let screenBeforeLeaderboard = $state<ScreenName>('title');
  let difficulty = $state<Difficulty>('medium');
  let game = $state<GameState | null>(null);
  let pendingDirection = $state<Direction>('right');
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const stopLoop = () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    timeoutId = undefined;
  };

  const onGameOver = () => {
    if (!game) return;
    if (game.score > $highScore) highScore.set(game.score);
    submitScore('snek', game.score);
    screen = 'gameover';
  };

  const loop = () => {
    // Apps are resident and never truly unmount, so the loop guards itself against a
    // screen change instead of relying on component-destruction cleanup — see the
    // `close` handlers below, which also call `stopLoop()` directly for the common
    // (Back-key) exit paths.
    if (screen !== 'playing' || !game) return;
    game = tick(game, pendingDirection);
    if (game.gameOver) {
      onGameOver();
      return;
    }
    timeoutId = setTimeout(loop, game.tickMs);
  };

  const startGame = (level: Difficulty) => {
    stopLoop();
    difficulty = level;
    game = createGame(level, { width: 16, height: 16 });
    pendingDirection = 'right';
    screen = 'playing';
    timeoutId = setTimeout(loop, game.tickMs);
  };

  const onMove = (direction: Direction) => {
    pendingDirection = direction;
  };

  const openLeaderboard = () => {
    screenBeforeLeaderboard = screen;
    screen = 'leaderboard';
  };

  const app = useAppLevels({
    appId: 'snek',
    title: 'Snek',
    onback: () => onback(),
    levels: [
      {
        open: () => screen === 'leaderboard',
        close: () => (screen = screenBeforeLeaderboard),
        title: 'Leaderboard'
      },
      {
        open: () => screen === 'gameover',
        close: () => (screen = 'title'),
        title: 'Game Over'
      },
      {
        open: () => screen === 'playing',
        close: () => {
          stopLoop();
          screen = 'title';
        },
        title: 'Snek'
      }
    ]
  });
</script>

<Screen title={app.title} onback={app.back}>
  {#if screen === 'title'}
    <div class="flex flex-col items-center gap-4 p-6">
      <h1 class="text-xl font-bold">Snek</h1>
      <div class="flex gap-2">
        <button type="button" onclick={() => startGame('easy')}>Easy</button>
        <button type="button" onclick={() => startGame('medium')}>Medium</button>
        <button type="button" onclick={() => startGame('hard')}>Hard</button>
      </div>
      <button type="button" onclick={openLeaderboard}>Leaderboard</button>
      <p>Best: {$highScore}</p>
    </div>
  {:else if screen === 'playing' && game}
    <Hud score={game.score} highScore={$highScore} multiplier={1} />
    <Board state={game} onmove={onMove} />
  {:else if screen === 'gameover' && game}
    <GameOverModal
      score={game.score}
      highScore={$highScore}
      onrestart={() => startGame(difficulty)}
      onviewleaderboard={openLeaderboard}
    />
  {:else if screen === 'leaderboard'}
    <Leaderboard onback={() => (screen = screenBeforeLeaderboard)} />
  {/if}
</Screen>
