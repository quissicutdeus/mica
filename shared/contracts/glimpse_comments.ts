// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { GlimpseComment } from '../types';

/**
 * Comments under a Glimpse post (MICA-253).
 *
 * Here rather than beside its `defineService` for the reason `blabber_dms` is: the id is not
 * the add-on's own, so naming it in core names no app. The posts contract is not here, for
 * the same rule read the other way — see `server/services/Glimpse.ts`.
 *
 * The generic create, get, update and delete are all off. A comment cannot be edited at all,
 * and deleting one is `remove`, because the post's owner may remove a comment they did not
 * write, which an ownership-scoped generic delete cannot express.
 *
 * **No schema in this file is an authorization check.** `ownedAccount` decides whether the
 * acting account belongs to the session and runs in every handler that takes one: an
 * `account_id` is a number in a payload, and nothing about a payload proves whose it is (§2.9).
 */
export const glimpseCommentsContract = defineContract({
  id: 'glimpse_comments',
  actions: {
    /**
     * Comment as one of the caller's accounts. The post must be active, and neither side may
     * have blocked the other; both are the handler's to check.
     */
    create: {
      input: s.object({
        account_id: s.positiveInt(),
        post_id: s.positiveInt(),
        /** `mica_glimpse_comments.body` is a varchar(300), and this is that number. */
        body: s.string({ min: 1, max: 300 })
      }),
      output: responseType<GlimpseComment>()
    },

    /** One post's comments, keyset-paged on `id DESC`. A public read: nothing names a viewer. */
    list: {
      input: s.object({
        post_id: s.positiveInt(),
        cursor: s.positiveInt().nullable().optional(),
        limit: s.positiveInt().optional()
      }),
      output: responseType<{ rows: GlimpseComment[]; nextCursor: number | null }>()
    },

    /**
     * Remove a comment, as its author or as the owner of the post it sits under. `account_id`
     * is the account acting; the handler checks it is the caller's, then that it is one of the
     * two. A soft delete, like every other.
     */
    remove: {
      input: s.object({ account_id: s.positiveInt(), id: s.positiveInt() }),
      output: responseType<boolean>()
    }
  }
});
