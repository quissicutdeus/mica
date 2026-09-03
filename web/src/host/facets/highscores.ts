// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { submitScore, getLeaderboard } from '../../services/highscores';

/**
 * OS Service Hook for the shared, cross-game leaderboard table.
 *
 * The only door into `gos_highscores` — no app, core or add-on, reaches the table any
 * other way. `app` is the game's own id ('snek' today); a second game reuses this hook rather
 * than adding a table.
 */
export function highscores() {
  return {
    submitScore,
    getLeaderboard
  };
}

registerFacet('highscores', highscores);
