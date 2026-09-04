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

export const getLeaderboard = async (app: string): Promise<LeaderboardEntry[]> => {
  const rows = await call(highscoresContract, 'top', { app }).catch(() => []);
  return Array.isArray(rows) ? rows : [];
};
