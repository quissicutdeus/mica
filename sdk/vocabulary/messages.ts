// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Conversation, Message } from '@mica/shared/types';

/**
 * The conversation and message shapes `Facets['messages']` hands an app. MICA-172 —
 * see `./accounts.ts`.
 *
 * Both extend a `@mica/shared/types` row the SDK already imports, so moving them in acquired no
 * new dependency: the wire shape stays shared with `server/`, and what is added here is the
 * UI's own projection of it.
 *
 * **Nobody else's identity is in either (MICA-339).** A conversation carries no creator
 * `citizenid` and no `participant_a`/`participant_b`; each of `participants` is the number on
 * the phone in the thread (`phone`) and whether it is the reader's own (`self`); a message says
 * whether the reader sent it (`mine`) and which member did (`sender_id`, a `participants[].id`)
 * instead of carrying the sender's `citizenid`. A name is the reader's own contact for that
 * number, or the number.
 */

export interface UIConversation extends Conversation {
  target: string; // The phone number or identifier of the other person
  targetName: string; // Display name
  targetAvatar?: string; // Contact profile image URL
  lastMessage: string; // Content string
  lastMessageAt: string; // ISO date
  unreadCount: number;
}

export interface UIMessage extends Message {
  sender: 'me' | 'other';
  replyToMsg?: UIMessage | null;
}

/**
 * What an arriving message may carry, as `Facets['messages'].addReceivedMessage` accepts it.
 *
 * Named because B1 found this shape spelled **twice** inside `facets.ts` — once inline on the
 * conversations member and once derived through
 * `Parameters<typeof conversationsStore.addReceivedMessage>[0]`. Two copies of one payload
 * shape in one file can drift silently, and the derived one was a `typeof` reaching into the
 * phone besides. One name, both call sites.
 */
export interface IncomingMessage {
  conversation_id?: number;
  message?: string;
  senderName?: string;
  phone?: string;
  avatar?: string;
  created_at?: string;
  reply_to_id?: number | null;
  /**
   * The sending member's `participants[].id` in the thread (MICA-339). `senderName` is only a
   * line's label now; a player's text carries no name, and is named from the reader's contacts
   * for `phone`.
   */
  sender_id?: number | null;
}
