// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { call } from '../nui/call';
import { highscoresContract } from '@mica/shared/contracts/highscores';
import type { LeaderboardEntry } from '@mica/shared/types';

/** Fire-and-forget: a failed submit must never block the game-over screen. */
export const submitScore = async (app: string, score: number): Promise<void> => {
  await call(highscoresContract, 'submit', { app, score }).catch(() => undefined);
};

/**
 * The top scores for one game. Rejects on failure, and on a reply that is not a list.
 *
 * It used to answer `[]` for both, which the leaderboard renders as "No scores yet" — a
 * board with real scores on it, reported empty because one request failed.
 */
export const getLeaderboard = async (app: string): Promise<LeaderboardEntry[]> => {
  const rows: unknown = await call(highscoresContract, 'top', { app });
  if (!Array.isArray(rows)) throw new Error('highscores:top answered without a list');
  return rows as LeaderboardEntry[];
};
