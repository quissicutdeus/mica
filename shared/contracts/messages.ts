// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Message, ReactionSummary } from '../types';

/**
 * Messages writes as `members`, so every generic action is closed and all seven here are
 * custom — `get` and `delete` included, despite their names.
 *
 * Nothing in this contract is an authorization check and nothing here replaces one.
 * `requireParticipant` is what decides whether the caller may see a thread, and it runs in the
 * handler against a membership table; a schema can only say that `conversation_id` is a
 * positive integer, which is not the same question and never was.
 */
export const messagesContract = defineContract({
  id: 'messages',
  actions: {
    /**
     * One page of a thread the caller is a live participant of, newest first (MICA-212).
     *
     * Keyset-paged like every other paged read: `cursor` is a bare row id, exclusive, and
     * `limit` is clamped to the service's `paging` rather than refused. The reply is
     * `{ rows, nextCursor }` — the shape the generic paged read answers — with the rows in
     * reading order (oldest first within the page) and `nextCursor: null` meaning the
     * oldest message in the thread is in this page. Not a bare array with the cursor inferred
     * from the last row, which is what this action and `conversations:get` both used to be:
     * a thread's cursor engages on every long thread rather than past a bound nobody reaches,
     * so the one empty round trip inference costs would be paid every time a thread divides by
     * fifty. `conversations:get` answers the same shape since MICA-211, where the cursor is
     * a `(time, id)` pair the client could not have derived from a row at all.
     */
    get: {
      input: s.object({
        conversation_id: s.positiveInt().optional(),
        id: s.positiveInt().optional(),
        cursor: s.positiveInt().nullable().optional(),
        limit: s.positiveInt().optional()
      }),
      output: responseType<{ rows: Message[]; nextCursor: number | null }>()
    },

    send: {
      input: s.object({
        conversation_id: s.positiveInt(),
        /**
         * `gos_messages.message` is `text`, and the handler still calls
         * `assertWritableValue`-equivalent bounds through the repository. A message with no
         * text is legal here and refused there, because it is only legal alongside an
         * attachment — a rule about the payload as a whole rather than about this field.
         */
        message: s.string({ max: 65535 }),
        /**
         * Up to `MAX_ATTACHMENTS` photos. `attachment` rides along from the composer's
         * optimistic render and is read by nothing on the server; it is declared so the
         * current client's request is not refused for carrying it.
         *
         * Ownership is still `resolveOwnedAttachments`' job: a `photo_id` naming a row the
         * caller does not own is dropped there, because "is this mine" is a query and not a
         * shape.
         */
        attachments: s
          .array(
            s.object({
              photo_id: s.positiveInt(),
              attachment: s.string({ max: 4 * 1024 * 1024 }).optional()
            }),
            { max: 4 }
          )
          .optional(),
        /**
         * The message this one quotes. Persisted on the row (MICA-209) and refused if it
         * does not sit in the same conversation, so a reply cannot quote across threads.
         */
        reply_to_id: s.positiveInt().nullable().optional()
      }),
      output: responseType<Message>()
    },

    edit: {
      input: s.object({ id: s.positiveInt(), message: s.string({ max: 65535 }) }),
      output: responseType<{ ok: boolean }>()
    },

    delete: { input: s.object({ id: s.positiveInt() }), output: responseType<boolean>() },

    react: {
      input: s.object({
        message_id: s.positiveInt(),
        /** One emoji. `isPlausibleEmoji`'s 1-16 characters, said in the declaration. */
        emoji: s.string({ min: 1, max: 16 })
      }),
      output: responseType<boolean>()
    },
    unreact: {
      input: s.object({ message_id: s.positiveInt(), emoji: s.string({ min: 1, max: 16 }) }),
      output: responseType<boolean>()
    },

    /**
     * Grouped counts for a page of messages.
     *
     * The handler used to drop unparseable ids and `slice(0, 60)` the rest, so a page longer
     * than sixty silently answered nothing for the tail — reactions that existed and did not
     * render. The bound is 200 and it is a refusal now: the app asks only for the messages it
     * has rendered, which is a window rather than a whole thread, so nothing legitimate
     * reaches it and a request that does is a client doing something else.
     */
    reactionsFor: {
      input: s.object({ target_ids: s.array(s.positiveInt(), { max: 200 }) }),
      output: responseType<Record<number, ReactionSummary>>()
    }
  }
});
