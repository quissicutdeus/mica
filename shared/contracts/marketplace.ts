// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Listing } from '../types';

/** Keyset paging, the same three-valued cursor every paged read here takes. */
const page = {
  cursor: s.positiveInt().nullable().optional(),
  limit: s.positiveInt().optional()
};

type Page = { rows: Listing[]; nextCursor: number | null };

/**
 * Classified listings. Every action is hand-written, `create` included: the generic one is
 * disabled because a listing's attachments are rows in a second table and its status is a
 * transition rather than a field.
 *
 * `price` is an `int(11)` — the same signed 32-bit range `defineService` gives every declared
 * int — and it is declared as one. `requirePrice` refused a fraction and a negative and said
 * nothing about the ceiling, so `Number.MAX_SAFE_INTEGER` reached MySQL, which in non-strict
 * mode clamps and reports success: a listing priced at two billion and something, and the
 * seller told it saved exactly as typed.
 */
export const marketplaceContract = defineContract({
  id: 'marketplace',
  actions: {
    create: {
      input: s.object({
        /** `mica_marketplace.title` is a varchar(100). */
        title: s.string({ min: 1, max: 100 }),
        price: s.int({ min: 0, max: 2147483647 }),
        /** `description` is `text`. */
        description: s.string({ min: 1, max: 65535 }),
        /**
         * Ownership is `resolveOwnedAttachments`' job — a `photo_id` naming a row the caller
         * does not own is dropped there, because "is this mine" is a query rather than a
         * shape. The count cap is `MAX_ATTACHMENTS`, applied before the resolver does the
         * work the cap exists to bound.
         */
        attachments: s.array(s.object({ photo_id: s.positiveInt() }), { max: 4 }).optional()
      }),
      output: responseType<Listing>()
    },

    /** One listing, plus the seller's contact number and whether it is the caller's own. */
    view: {
      input: s.object({ id: s.positiveInt() }),
      output: responseType<Listing & { contactPhone: string | null; isOwn: boolean }>()
    },

    feed: { input: s.object(page), output: responseType<Page>() },

    /**
     * `q` used to fall back to `''` when absent, which is a `LIKE '%%'` over the whole public
     * table on a payload that named nothing. Required now; an empty string is still legal,
     * because clearing a search box is a real thing to do and the paging bounds the answer.
     */
    search: {
      input: s.object({ q: s.string({ max: 64 }), ...page }),
      output: responseType<Page>()
    },

    /** The caller's own listings, every status. Not a public read: full rows. */
    mine: { input: s.object(page), output: responseType<Page>() },

    markSold: { input: s.object({ id: s.positiveInt() }), output: responseType<boolean>() },
    remove: { input: s.object({ id: s.positiveInt() }), output: responseType<boolean>() }
  }
});
