// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Report, ReportResolution } from '../types';

/**
 * Moderation: one action anybody may call and four only an admin may.
 *
 * The admin gate stays in the handlers, and this contract does not weaken it. `isAdmin(source)`
 * asks about the connection, not about the payload, so it is not a thing a schema could express
 * — and `queue`, `history`, `reopen` and `resolve` are reachable net events whether or not the
 * Administration app is on screen, which is why the gate is there rather than in the UI.
 */
export const reportsContract = defineContract({
  id: 'reports',
  actions: {
    create: {
      input: s.object({
        /**
         * Which table the reported row lives in. Bounded here, allowlisted in
         * `server/lib/moderation.ts` — the list is a registry apps declare into through
         * `defineService({ reportable })`, so `shared/` is not where it can be known.
         */
        targetTable: s.string({ min: 1, max: 64 }),
        targetId: s.positiveInt(),
        /**
         * Optional, and an unrecognised one still becomes `other` in the handler rather than
         * a refusal. A report filed under a category the queue does not have is still a
         * report, and losing it to a spelling would be the wrong trade.
         */
        category: s.string({ max: 32 }).optional(),
        /** Free text from the reporter. `gos_reports.note` is a varchar(500). */
        note: s.string({ max: 500 }).optional()
      }),
      output: responseType<{ id: number }>()
    },

    queue: { input: s.none(), output: responseType<Report[]>() },
    history: { input: s.none(), output: responseType<Report[]>() },

    reopen: {
      input: s.object({ id: s.positiveInt() }),
      output: responseType<{ ok: boolean; resolution: ReportResolution }>()
    },

    resolve: {
      input: s.object({
        id: s.positiveInt(),
        /**
         * A closed pair, and it is closed here rather than by a ternary.
         *
         * The handler read `action === 'moderate' ? 'moderate' : 'dismiss'`, so every typo,
         * every missing field and every hostile value became **dismiss** — the destructive
         * default in the sense that matters: it closes a report without anyone deciding to.
         */
        action: s.enum(['moderate', 'dismiss'])
      }),
      output: responseType<{ ok: boolean; resolution: ReportResolution }>()
    }
  }
});
