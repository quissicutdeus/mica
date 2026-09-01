// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Conversation, Message } from '@gphone/shared/types';

/**
 * The conversation and message shapes `Facets['messages']` hands an app. MICA-172 —
 * see `./accounts.ts`.
 *
 * Both extend a `@gphone/shared/types` row the SDK already imports, so moving them in acquired no
 * new dependency: the wire shape stays shared with `server/`, and what is added here is the
 * UI's own projection of it.
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
}
