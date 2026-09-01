// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { SavedPlace } from '../types';

/**
 * Saved places: one custom action, and it is called `create`.
 *
 * The generic `create` is disabled, because the coordinates are read from the player's own
 * position server-side and a payload has no business naming them. What replaces it is a
 * hand-written handler, so it is a custom action and belongs here like any other — the
 * distinction `ServiceEndpoint` makes is the registration path, never the name.
 *
 * Both string bounds are the declared column lengths, so a name that would not fit is refused
 * rather than silently shortened on the way in.
 */
export const placesContract = defineContract({
  id: 'places',
  actions: {
    create: {
      input: s.object({
        name: s.string({ min: 1, max: 100 }),
        /**
         * Cosmetic display text only, the same trust level `media:shareLocation`'s `label`
         * carries — never resolved against anything, never used to authorize a read.
         */
        street_label: s.string({ min: 1, max: 255 }).optional()
      }),
      output: responseType<{ id: number; place: SavedPlace | null }>()
    }
  }
});
