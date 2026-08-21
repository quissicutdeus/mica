import './inProcess/facets/highscores';
import { guarded } from './guard';

/**
 * OS Service Hook for the shared, cross-game leaderboard table.
 */
export function useHighscores() {
  return guarded('useHighscores').facets.highscores();
}
