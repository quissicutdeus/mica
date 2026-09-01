// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { PhoneSetting } from '../types';

/**
 * Preferences, addressed by `(app, key)` and never by row id — which is why no generic CRUD
 * action survives here and all four of these are custom.
 *
 * The bounds are `gphone_settings`'s own column lengths. Neither `app` nor `key` is ever
 * interpolated into SQL, so the risk they carry is not injection: it is a value too long for
 * its column, which MySQL truncates silently in non-strict mode. Refusing beats truncating,
 * because a preference that silently saved under a different key is a preference that reads
 * back as unset forever.
 */
export const settingsContract = defineContract({
  id: 'settings',
  actions: {
    getAll: { input: s.none(), output: responseType<PhoneSetting[]>() },

    set: {
      input: s.object({
        app: s.string({ min: 1, max: 32 }),
        key: s.string({ min: 1, max: 64 }),
        /**
         * The one `s.unknown()` in the repo, and it should stay that way.
         *
         * A setting's value is app-owned JSON the OS has no business having an opinion
         * about — a boolean, a colour, a shortcut map. `useStorage` has already stringified
         * it by the time it gets here; the handler stringifies anything else so the column
         * always holds one parseable value, then enforces the 8KB ceiling that stops a
         * base64 wallpaper arriving by a route nobody intended.
         */
        value: s.unknown()
      }),
      output: responseType<boolean>()
    },

    remove: {
      input: s.object({ app: s.string({ min: 1, max: 32 }), key: s.string({ min: 1, max: 64 }) }),
      output: responseType<boolean>()
    },

    clearApp: {
      input: s.object({ app: s.string({ min: 1, max: 32 }) }),
      output: responseType<boolean>()
    }
  }
});
