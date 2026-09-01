// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Mail } from '../types';

/**
 * Mail is receive-only, and this contract is the shape of that decision.
 *
 * `access: { write: 'server' }` closes the generic create and update; `disableGet` and
 * `disableDelete` close the other two, because the list needs an explicit ORDER BY and the
 * deletes carry their own audit entries. So every reachable mail action is here, and the four
 * of them are reading and filing — nothing composes or replies, which
 * `server/__tests__/reachability.test.ts` pins as a closed set rather than as an absence.
 *
 * A contract makes that harder to undo by accident than it already was: an action added to
 * `services/Mail.ts` without an entry here fails at resource start.
 */
export const mailContract = defineContract({
  id: 'mail',
  actions: {
    getMail: { input: s.none(), output: responseType<Mail[]>() },
    markAsRead: { input: s.object({ id: s.positiveInt() }), output: responseType<boolean>() },
    archiveMail: {
      input: s.object({
        id: s.positiveInt(),
        /**
         * Optional, and absent means archive. `flagUnlessFalse` read it as "true unless the
         * client explicitly said false", which is the shape a toggle sends when it only ever
         * names the direction it wants; the handler keeps that reading.
         */
        archive: s.boolean().optional()
      }),
      output: responseType<boolean>()
    },
    deleteMail: { input: s.object({ id: s.positiveInt() }), output: responseType<boolean>() }
  }
});
