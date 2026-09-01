// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';

/**
 * The lock screen's four actions, all custom: the row is addressed by citizenid and never by
 * id, so no generic action has anything to act on.
 *
 * `set` and `check` take the same field and are deliberately **not** given the same schema.
 *
 * `set` carries the real rule, `/^\d{4,6}$/`, which is exactly what the handler threw on
 * before: a passcode that is not four to six digits is not a passcode.
 *
 * `check` only bounds the length. A guess of the wrong shape has always answered `{ ok: false }`
 * rather than erroring, and that stays true — refusing it here would tell a caller "that was
 * not even the right shape", which is one bit more than a wrong guess is owed, and it would
 * answer in a fraction of the time a real check takes. `check` is the one action in the phone
 * with a timing property worth keeping (`timingSafeStringEqual`, and the KDF run even when no
 * row exists); a validation step whose cost varied with the input would be a stopwatch pointed
 * at exactly that.
 */

export const lockscreenContract = defineContract({
  id: 'lockscreen',
  actions: {
    /** Whether a passcode exists. Never the passcode, the hash, or the salt. */
    status: { input: s.none(), output: responseType<{ hasPasscode: boolean }>() },
    set: {
      input: s.object({ passcode: s.string({ pattern: /^\d{4,6}$/ }) }),
      output: responseType<{ ok: boolean }>()
    },
    check: {
      // No `min`: an empty guess is a guess, and it has always answered `false` rather than
      // erroring. Only the type and the ceiling are the schema's business here.
      input: s.object({ passcode: s.string({ max: 32 }) }),
      output: responseType<{ ok: boolean }>()
    },
    clear: { input: s.none(), output: responseType<{ ok: boolean }>() }
  }
});
