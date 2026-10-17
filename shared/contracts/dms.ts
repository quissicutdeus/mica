// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { DirectMessage, DirectMessageThread } from '../types';

/**
 * Private messages between two accounts on the shared identity layer, for any social app.
 *
 * This is `blabber_dms` with the app made a parameter: Blabber's DMs were hard-wired to its
 * own id, and a `core: false` add-on can only reach a service under its own name, so a dating
 * add-on that wanted a message after a match had nowhere to send it. The id `dms` names no
 * app, so core may hold it. The table is still `mica_blabber_dms`: every sealed body is bound
 * to its table name, and a rename would re-seal every message for nothing.
 *
 * Every action names the account the caller is acting **as**, and the app that account lives
 * in, and none of these schemas is what makes that safe. `ownedAccount` runs in every handler,
 * and a per-app policy (`registerDmPolicy` in `server/services/DirectMessages.ts`) decides who
 * may message whom in that app; an app with no policy is refused. An `account_id` is a number
 * in a payload and nothing about a payload proves it belongs to whoever sent it (§2.9).
 *
 * The delete action is deliberately absent, and stays absent: a sent message is not
 * unsendable here, which `server/__tests__/reachability.test.ts` pins as a closed set.
 */
const thread = {
  /** The app both accounts live in. A policy is looked up by it, and the push routes to it. */
  app: s.string({ min: 1, max: 32 }),
  account_id: s.positiveInt(),
  peer_account_id: s.positiveInt()
};

export const dmsContract = defineContract({
  id: 'dms',
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
      output: responseType<{ rows: DirectMessage[]; nextCursor: number | null }>()
    },

    /** Every correspondent in one app, with the last message and an unread count. */
    threads: {
      input: s.object({ app: s.string({ min: 1, max: 32 }) }),
      output: responseType<DirectMessageThread[]>()
    },

    send: {
      input: s.object({
        ...thread,
        /** `mica_blabber_dms.body` is a varchar(500), and this is that number. */
        body: s.string({ min: 1, max: 500 })
      }),
      output: responseType<DirectMessage>()
    },

    /** Mark a correspondent's messages read. The WHERE clause is the authorization. */
    read: { input: s.object(thread), output: responseType<boolean>() }
  }
});
