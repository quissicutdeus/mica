import { submitScore, getLeaderboard } from '../../services/highscores';

/**
 * OS Service Hook for the shared, cross-game leaderboard table.
 *
 * The only door into `gphone_highscores` — no app, core or add-on, reaches the table any
 * other way. `app` is the game's own id ('snek' today); a second game reuses this hook rather
 * than adding a table.
 */
export function useHighscores() {
  return {
    submitScore,
    getLeaderboard
  };
}
