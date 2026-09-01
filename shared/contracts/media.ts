// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { MediaItem } from '../types';

/**
 * The media service's custom actions.
 *
 * Generic `get`, `create` and `delete` are derived from the column declaration in
 * `server/services/Media.ts` and are not restated here — the write allowlist and
 * `columnRules` are what validate those.
 */
export const mediaContract = defineContract({
  id: 'media',
  actions: {
    /** Bring one soft-deleted row back, if it is still inside the restore window. */
    restore: {
      input: s.object({ id: s.positiveInt() }),
      output: responseType<{ ok: boolean }>()
    },

    /** The "Recently Deleted" list. Takes no payload — the caller is the whole predicate. */
    getDeleted: {
      input: s.none(),
      output: responseType<Partial<MediaItem>[]>()
    },

    /**
     * The bytes for exactly one row the caller owns.
     *
     * The handler read `data.id` **or a bare id**, because the payload was `unknown` and both
     * spellings had been seen. The web sends `{ id }` from both of its call sites, so the
     * contract says so and the bare form stops being reachable.
     */
    item: {
      input: s.object({ id: s.positiveInt() }),
      output: responseType<MediaItem>()
    },

    /**
     * Store a thumbnail the client generated for a row that had none.
     *
     * The 64KB cap and the `data:image/` prefix are the two rules that stop store-back
     * becoming a second way to keep a full-size photo, so both live in the declaration rather
     * than in the handler. `mediumtext` holds 16MB and would accept every one of them.
     */
    thumbnail: {
      input: s.object({
        id: s.positiveInt(),
        thumbnail: s.string({ min: 1, max: 64 * 1024, pattern: /^\s*data:image\//i })
      }),
      output: responseType<{ stored: boolean }>()
    },

    /** Bluetooth proximity drop: copy one of the caller's own rows to everyone nearby. */
    drop: {
      input: s.object({ mediaId: s.positiveInt() }),
      output: responseType<{ count: number; offline?: number }>()
    },

    /**
     * Share the caller's current location as a media row.
     *
     * `clientPrepared`, and the only action in the repo that is. The web calls it with `{}`;
     * `client/services/Location.ts` discards that, resolves the street name from
     * `GetStreetNameAtCoord` — a native, so only the game client can answer it — and forwards
     * `{ label }`. So `label` is a field the UI never sends and the server always sees, which
     * is exactly the sort of thing that has to be written down somewhere all three bundles
     * read.
     */
    shareLocation: {
      input: s.object({ label: s.string({ min: 1, max: 255 }).optional() }),
      output: responseType<{ id: number; media: MediaItem | null }>(),
      clientPrepared: true
    }
  }
});
