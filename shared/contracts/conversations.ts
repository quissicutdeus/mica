// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Conversation } from '../types';

/**
 * A thread id, in the two spellings the UI has ever used.
 *
 * `conversationIdFrom` accepts `{ conversation_id }`, `{ id }` or a bare number, because the
 * UI was never consistent. The object forms are both declared; the **bare** form is not, and
 * stops being reachable — nothing in `web/` sends one, and an action whose payload might not
 * be an object is an action whose payload cannot be described.
 *
 * Both keys are optional and the handler still resolves which one arrived, because "exactly
 * one of these" is a rule about a payload rather than about a field. Sending neither is
 * refused there, with the same message it always used.
 */
const threadRef = {
  conversation_id: s.positiveInt().optional(),
  id: s.positiveInt().optional()
};

/**
 * Conversations: `get`, `create` and `delete` are hand-written and therefore custom, even
 * though three of those are generic-sounding names. What decides is the registration path.
 *
 * `update` is **not** here, and that is the interesting one: renaming a thread rides the
 * ordinary ownership-scoped generic `update`, so only the creator can do it and the write
 * allowlist is what validates it. A service can mix the two.
 */
export const conversationsContract = defineContract({
  id: 'conversations',
  actions: {
    /**
     * The caller's threads, keyset-paged — but on **last-message recency**, not on `id DESC`
     * like every other paged read here (MICA-211).
     *
     * That is why the cursor is a pair rather than a bare row id. The inbox is ordered by when
     * a thread was last written in, and an old thread somebody texts daily has a low id and a
     * recent last message, so an id cannot name a position in that order. `time` is the last
     * message's timestamp (the thread's own `updated_at` for one nobody has written in yet)
     * and `id` is the tiebreak between two threads that share a second. Both halves are
     * required: a cursor missing either is not a position.
     *
     * The reply is `{ rows, nextCursor }` — the shape the generic paged read answers, and the
     * shape `messages:get` moved to in MICA-212 — with `null` meaning the oldest thread is in
     * this page. Not a bare array with the cursor inferred from the last row, as this action
     * used to be: a compound cursor is not derivable from a row the client holds, and the
     * inference also cost one empty request whenever the list divided exactly by the page size,
     * which stopped being free when the page came down to a screenful.
     */
    get: {
      input: s.object({
        cursor: s
          .object({
            time: s.string({ min: 1, max: 32 }),
            id: s.positiveInt()
          })
          .nullable()
          .optional(),
        limit: s.positiveInt().optional()
      }),
      output: responseType<{
        rows: Conversation[];
        nextCursor: { time: string; id: number } | null;
      }>()
    },

    create: {
      input: s.object({
        /** The other party, as a number. Resolved server-side, and never a raw citizenid. */
        phone: s.string({ min: 1, max: 32 }).optional(),
        /** A thread name the creator chose. `gphone_messages_conversations.name` is a varchar(255). */
        name: s.string({ min: 1, max: 255 }).optional(),
        /**
         * Group members, each a phone number resolved the same way `phone` is.
         *
         * The bound here is a flood guard and **not** the member cap. The cap is 32 people,
         * and the handler applies it after deduplicating — so five hundred spellings of one
         * number is a one-person thread and a single directory lookup, which is a request
         * worth keeping legal. A schema counts entries and cannot know how many people they
         * are. What it can do is stop a list nothing could have meant from arriving at all.
         */
        participants: s.array(s.string({ min: 1, max: 32 }), { max: 512 }).optional(),
        /**
         * A contact card the UI sometimes sends, used for its display name and nothing else.
         * It is **never** read as a citizenid: a raw citizenid is no proof the caller knows
         * this person, and a modified client could otherwise force its way into a thread with
         * anyone whose id it could guess. Narrowed to the two fields `nameOf` reads.
         */
        participant: s
          .object({
            firstname: s.string({ max: 50 }).optional(),
            lastname: s.string({ max: 50 }).optional()
          })
          .optional(),
        /**
         * Sent by the web and read by nothing.
         *
         * `is_group` is derived from how many people end up in the thread, and it must be:
         * the Messages UI gates every affordance that would reveal an extra participant on
         * it, so a client that could set it could stand a third account inside a thread the
         * victim is shown as a private DM (MICA-153). Declared only because the current
         * client still sends it and a strict object would otherwise refuse the request.
         */
        is_group: s.boolean().optional()
      }),
      output: responseType<Conversation | null>()
    },

    /** Mark this participant's thread read. Scoped to their own participant row. */
    read: { input: s.object(threadRef), output: responseType<boolean>() },

    archive: {
      input: s.object({
        ...threadRef,
        /**
         * The state the caller wants, named in full. Required, because the field this
         * replaced was an optional `archive` flag that the web never sent and the handler
         * defaulted to `true`, so every call archived and nothing ever came back
         * (MICA-208). A required enum has no absent case to default.
         */
        status: s.enum(['archived', 'active'])
      }),
      output: responseType<boolean>()
    },

    delete: { input: s.object(threadRef), output: responseType<boolean>() }
  }
});
