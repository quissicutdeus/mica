// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { BlabberDm, BlabberDmThread } from '../types';

/**
 * Private messages between two accounts on the shared identity layer.
 *
 * Every action names the account the caller is acting **as**, and none of these schemas is
 * what makes that safe: `ownedAccount` is, and it runs in every handler. An `account_id` is a
 * number in a payload and nothing about a payload proves it belongs to whoever sent it (§2.9).
 * Declaring it a positive integer says what it is, never whose — the same division of labour
 * the accounts contract next door describes.
 *
 * The delete action is deliberately absent, and stays absent: a sent message is not
 * unsendable here, which `server/__tests__/reachability.test.ts` pins as a closed set.
 */
const thread = {
  account_id: s.positiveInt(),
  peer_account_id: s.positiveInt()
};

export const blabberDmsContract = defineContract({
  id: 'blabber_dms',
  actions: {
    /** One thread, newest first, keyset-paged on the message id. */
    get: {
      input: s.object({
        ...thread,
        cursor: s.positiveInt().nullable().optional(),
        /** Clamped to 80 in the handler, as it always was: a high number is a legitimate
         * request with a wrong value in it, not a refusable one. */
        limit: s.positiveInt().optional()
      }),
      output: responseType<{ rows: BlabberDm[]; nextCursor: number | null }>()
    },

    /** Every correspondent, with the last message and an unread count. Takes no payload. */
    threads: { input: s.none(), output: responseType<BlabberDmThread[]>() },

    send: {
      input: s.object({
        ...thread,
        /** `gphone_blabber_dms.body` is a varchar(500), and this is that number. */
        body: s.string({ min: 1, max: 500 })
      }),
      output: responseType<BlabberDm>()
    },

    /** Mark a correspondent's messages read. The WHERE clause is the authorization. */
    read: { input: s.object(thread), output: responseType<boolean>() }
  }
});
