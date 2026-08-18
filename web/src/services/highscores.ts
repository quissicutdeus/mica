import { fetchNui } from '../nui/fetchNui';
import type { LeaderboardEntry } from '@shared/types';

/** Fire-and-forget: a failed submit must never block the game-over screen. */
export const submitScore = async (app: string, score: number): Promise<void> => {
  await fetchNui('submitHighscore', { app, score }).catch(() => undefined);
};

export const getLeaderboard = async (app: string): Promise<LeaderboardEntry[]> => {
  const rows = await fetchNui<LeaderboardEntry[]>('getHighscoreLeaderboard', { app }).catch(
    () => []
  );
  return Array.isArray(rows) ? rows : [];
};
