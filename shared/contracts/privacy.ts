// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { PrivacyDeleteResult, PrivacyExport } from '../types';

/**
 * The word a player types to confirm deleting everything micaOS holds for their character
 * (MICA-168). Literal, English, case-sensitive, and the same in every locale: the UI shows it
 * inside a translated sentence, and the server compares it exactly.
 */
export const PRIVACY_DELETE_CONFIRMATION = 'DELETE';

/**
 * A player's own data: read all of it, or delete all of it. MICA-168.
 *
 * Neither action takes an identity. The citizenid is always the authenticated session's, so
 * there is nothing in either payload a client could point at somebody else (§2.9).
 */
export const privacyContract = defineContract({
  id: 'privacy',
  actions: {
    /** Every owned row, grouped by category, secrets withheld and media bytes as sizes. */
    export: { input: s.none(), output: responseType<PrivacyExport>() },

    /**
     * Delete everything. `confirm` is bounded but not patterned here: a wrong word is a
     * player-facing refusal the handler gives in their language, not a schema error.
     */
    delete: {
      input: s.object({ confirm: s.string({ max: 32 }) }),
      output: responseType<PrivacyDeleteResult>()
    }
  }
});
