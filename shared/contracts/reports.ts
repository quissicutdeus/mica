// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Report, ReportResolution } from '../types';

/**
 * One version of a reported row's content (MICA-430): what an edit replaced, opened for staff.
 * `values` are the replaced columns by name, each as text, or null; a sealed one no loaded key
 * opens reads as the padlock. Never an owner key or a binding column: `by_owner` says whether
 * the row's own owner made the edit, and null when the server or staff did.
 */
const contentVersion = s.object(
  {
    id: s.positiveInt(),
    reason: s.enum(['edit', 'rename', 'revive', 'handover', 'rejoin']),
    /** When the edit replaced it. */
    replaced_at: s.string(),
    /** When the replaced value had itself been written, where the row keeps that. */
    written_at: s.string().nullable(),
    by_owner: s.boolean().nullable(),
    values: s.array(
      s.object({ column: s.string(), value: s.string().nullable() }, { unknownKeys: 'strip' })
    )
  },
  { unknownKeys: 'strip' }
);

/**
 * Moderation: one action anybody may call and five only an admin may.
 *
 * The admin gate stays in the handlers, and this contract does not weaken it. `isAdmin(source)`
 * asks about the connection, not about the payload, so it is not a thing a schema could express
 * — and `queue`, `history`, `reopen`, `resolve` and `versions` are reachable net events whether or not the
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
        /** Free text from the reporter. `mica_reports.note` is a varchar(500). */
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
    },

    /**
     * Every version of the reported row's content, oldest first (MICA-430): what each edit
     * replaced. By report, so the table and row come from a filed report and never from the
     * payload; a real schema, so the reply is held to it on the way out.
     */
    versions: {
      input: s.object({ id: s.positiveInt() }),
      output: s.array(contentVersion)
    }
  }
});
