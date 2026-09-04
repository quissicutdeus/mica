// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Account } from '../types';

/**
 * Which app's identity graph a request is about. Every action here needs it, and no action
 * treats it as optional: the app segment is the only thing keeping two graphs apart, so a
 * request that does not name one is not a request about anything.
 *
 * `mica_accounts.app` is a varchar(32). The value itself is not enumerated — it names an
 * app, and half the apps that use this service are not in this repository.
 */
const app = s.string({ min: 1, max: 32 });

/** One emoji: `isPlausibleEmoji`'s 1-16 characters, moved into the declaration. */
const emoji = s.string({ min: 1, max: 16 });

/**
 * A reactable table, bound as a **value** and never interpolated as an identifier.
 *
 * So this is not the SQL boundary the reportable allowlist is — but an unchecked one would
 * still let a client invent a namespace and pollute counts for a table it has no business
 * reacting to, which is why `isReactableTable` stays in the handler on top of this bound.
 */
const targetTable = s.string({ min: 1, max: 64 });

const page = {
  cursor: s.positiveInt().nullable().optional(),
  limit: s.positiveInt().optional()
};

/**
 * The shared identity layer every social app builds on: accounts, follows, blocks, reactions.
 *
 * Twelve custom actions and one generic one. `get` is the public paged read and stays derived
 * from the columns — it is how a profile is looked up by handle, through the `clientFilterable`
 * set rather than through anything here.
 *
 * **No schema in this file is an authorization check.** `ownedAccount` is what decides whether
 * the acting account belongs to the session, and it runs in every one of these handlers: a
 * `follower_account_id` is a number in a payload, and nothing about a payload proves it belongs
 * to whoever sent it (§2.9). Declaring it a positive integer says what it is, never whose.
 */
export const accountsContract = defineContract({
  id: 'accounts',
  actions: {
    /** The caller's own identities in one app, plus the per-app cap the UI has to draw. */
    mine: {
      input: s.object({ app }),
      output: responseType<{ rows: Account[]; limit: number }>()
    },

    create: {
      input: s.object({
        app,
        /**
         * Bounded, and deliberately **not** patterned here.
         *
         * The rule is `/^[a-z0-9_]{3,32}$/`, and the handler applies it *after* lowercasing —
         * so a player typing `MyHandle` gets `myhandle` rather than a refusal. Putting the
         * pattern in the contract would refuse the capital before anything could fold it, and
         * a case-insensitive pattern here would be a second, subtly different rule.
         */
        handle: s.string({ min: 3, max: 32 }),
        display_name: s.string({ max: 50 }).optional()
      }),
      output: responseType<Account>()
    },

    follow: {
      input: s.object({
        app,
        follower_account_id: s.positiveInt(),
        followee_account_id: s.positiveInt()
      }),
      output: responseType<boolean>()
    },
    unfollow: {
      input: s.object({
        app,
        follower_account_id: s.positiveInt(),
        followee_account_id: s.positiveInt()
      }),
      output: responseType<boolean>()
    },

    block: {
      input: s.object({
        app,
        blocker_account_id: s.positiveInt(),
        blocked_account_id: s.positiveInt()
      }),
      output: responseType<boolean>()
    },
    unblock: {
      input: s.object({
        app,
        blocker_account_id: s.positiveInt(),
        blocked_account_id: s.positiveInt()
      }),
      output: responseType<boolean>()
    },

    react: {
      input: s.object({
        app,
        account_id: s.positiveInt(),
        target_table: targetTable,
        target_id: s.positiveInt(),
        emoji
      }),
      output: responseType<boolean>()
    },
    unreact: {
      input: s.object({
        app,
        account_id: s.positiveInt(),
        target_table: targetTable,
        target_id: s.positiveInt(),
        emoji
      }),
      output: responseType<boolean>()
    },

    /**
     * Grouped counts for a page of targets on one table.
     *
     * The handler dropped unparseable ids and `slice(0, 60)`'d the rest, so a page longer than
     * sixty silently answered nothing for its tail. Bounded at 200 and refused past it: the
     * app asks for the rows it has rendered, which is a window rather than a whole feed.
     */
    reactionsFor: {
      input: s.object({
        app,
        target_table: targetTable,
        target_ids: s.array(s.positiveInt(), { max: 200 })
      }),
      output: responseType<Record<number, { counts: Record<string, number>; mine: string[] }>>()
    },

    /**
     * Counts for one account, plus whether the viewer follows or has blocked it.
     *
     * `viewer_account_id` is optional and three-valued on purpose: absent, explicitly null, or
     * an id. An absent or unowned viewer answers `false` rather than erroring — reading a
     * profile is not a privileged act, and only the *button* needs an identity.
     */
    follows: {
      input: s.object({
        app,
        account_id: s.positiveInt(),
        viewer_account_id: s.positiveInt().nullable().optional()
      }),
      output: responseType<{
        followers: number;
        following: number;
        followedByMe: boolean;
        blockedByMe: boolean;
      }>()
    },

    followers: {
      input: s.object({ app, account_id: s.positiveInt(), ...page }),
      output: responseType<{ rows: Account[]; nextCursor: number | null }>()
    },
    following: {
      input: s.object({ app, account_id: s.positiveInt(), ...page }),
      output: responseType<{ rows: Account[]; nextCursor: number | null }>()
    },

    /**
     * Handle and display-name search.
     *
     * `q` was sliced to 64 characters and became `''` when absent, which is a search for
     * everything — a full public scan on a payload that named nothing. It is required and
     * bounded now; an empty string is still legal, because clearing a search box is a real
     * thing to do and the paging is what bounds the answer.
     */
    search: {
      input: s.object({ app, q: s.string({ max: 64 }), ...page }),
      output: responseType<{ rows: Account[]; nextCursor: number | null }>()
    }
  }
});
