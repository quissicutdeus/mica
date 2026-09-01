// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { LeaderboardEntry } from '../types';

/**
 * Leaderboards, one per game.
 *
 * `app` is bounded here and **not** enumerated, deliberately. The list of games that have a
 * board is `KNOWN_APPS` in `server/services/Highscores.ts`, and it names an app the Store
 * installs — which core may not do (`sdk/coreBoundary.test.ts`). So the contract says what
 * shape the field has and the service says which values exist; the check is still there, it
 * is just in the half of the tree allowed to know the answer.
 *
 * The 32-character bound is `gphone_highscores.app`'s own declared length.
 */
export const highscoresContract = defineContract({
  id: 'highscores',
  actions: {
    submit: {
      input: s.object({
        app: s.string({ min: 1, max: 32 }),
        /**
         * Above a million a score is not a play session, it is a bug or a modified client.
         * `upsertBest` only ever raises the caller's own row, so a plausible ceiling is all
         * the protection the board needs.
         */
        score: s.int({ min: 0, max: 1_000_000 })
      }),
      output: responseType<{ ok: boolean }>()
    },
    top: {
      input: s.object({ app: s.string({ min: 1, max: 32 }) }),
      output: responseType<LeaderboardEntry[]>()
    }
  }
});
