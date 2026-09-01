// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for the shared, cross-game leaderboard table.
 */
export function useHighscores() {
  return guarded('useHighscores').facets.highscores();
}
