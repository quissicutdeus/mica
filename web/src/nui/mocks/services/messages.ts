// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MESSAGE_BODY_MAX } from '@mica/shared/contracts/messages';
import type { Conversation, Message } from '@mica/shared/types';
import { mockConversations, mockMedia, mockMessages } from '../data';
import type { MockHandler } from '../registry';
import { delay } from '../shared';

/**
 * Reactions on a Messages thread (MICA-143), keyed by citizenid rather than an account —
 * `mica_messages_reactions` is its own table, not `mica_account_reactions`, and Messages
 * has no account layer to key on instead. Separate array from `mockReactions`
 * (`services/accounts.ts`) for the same reason: two different tables, two different
 * identity columns.
 *
 * Seeded with two other participants' reactions on one message in "Union Depository Heist"
 * (conversation id 2, its oldest message, id 2001 — see `mockConversations` in `data.ts`), a
 * >2-person group. The Messages e2e spec's group-conversation coverage needs a count that
 * already includes reactions from someone other than the mock's own identity to assert
 * against — the question MICA-143 raised was whether an aggregated count across more than
 * one other participant reads correctly, and a fixture with zero other reactors could never
 * exercise that.
 */
const mockMessageReactions: { messageId: number; citizenid: string; emoji: string }[] = [
  { messageId: 2001, citizenid: 'group-heist-member-a', emoji: '🔥' },
  { messageId: 2001, citizenid: 'group-heist-member-b', emoji: '🔥' }
];

export const mocks: Record<string, MockHandler> = {
  // Messages
  /**
   * One page of the inbox, the way the server answers it (MICA-211): keyset on
   * `(last-message time, id)` descending — not on `id DESC` — the cursor that same pair and
   * exclusive, `limit` clamped to the service's declared page (25 by default, 200 at most),
   * and `{ rows, nextCursor }` back with `null` once the oldest thread is in the page.
   *
   * The sort key is the last message's `created_at` falling back to the thread's `updated_at`,
   * which is the expression the server's SQL uses and the one `lastMessageAt` is built from. A
   * mock that paged by id instead would agree with the server on this fixture by accident —
   * the fixture's ids happen to descend with recency — and disagree with it on any inbox where
   * an old thread is still active, which is the entire case this ticket is about.
   */
  'conversations:get': ({
    cursor,
    limit
  }: {
    cursor?: { time: string; id: number } | null;
    limit?: number;
  } = {}) => {
    const pageSize = Math.min(typeof limit === 'number' && limit > 0 ? limit : 25, 200);
    const keyOf = (c: Conversation) => String(c.last_message?.created_at ?? c.updated_at ?? '');

    const ordered = [...mockConversations].sort((a, b) => {
      const byTime = keyOf(b).localeCompare(keyOf(a));
      return byTime !== 0 ? byTime : b.id - a.id;
    });

    const after = cursor
      ? ordered.filter((c) => {
          const key = keyOf(c);
          return key < cursor.time || (key === cursor.time && c.id < cursor.id);
        })
      : ordered;

    const hasMore = after.length > pageSize;
    const rows = after.slice(0, pageSize);
    const last = rows[rows.length - 1];
    return {
      rows,
      nextCursor: hasMore && last ? { time: keyOf(last), id: last.id } : null
    };
  },
  /**
   * One page of a thread, the way `messages:get` answers it (MICA-212): keyset on
   * `id DESC`, the cursor a bare row id and exclusive, `limit` clamped to the service's
   * declared page — fifty by default, a hundred at most — and `{ rows, nextCursor }` back,
   * the rows in reading order and `nextCursor` null once the oldest message is in the page.
   * The e2e specs walk a 200-message fixture through this in four pages.
   */
  'messages:get': ({
    conversation_id,
    cursor,
    limit
  }: {
    conversation_id: number;
    cursor?: number | null;
    limit?: number;
  }) => {
    const pageSize = Math.min(typeof limit === 'number' && limit > 0 ? limit : 50, 100);
    const newestFirst = [...(mockMessages[conversation_id] || [])]
      .sort((a, b) => b.id - a.id)
      .filter((m) => (cursor == null ? true : m.id < cursor));
    const hasMore = newestFirst.length > pageSize;
    const page = newestFirst.slice(0, pageSize);
    const oldest = page[page.length - 1];
    return {
      rows: [...page].reverse(),
      nextCursor: hasMore && oldest ? oldest.id : null
    };
  },
  'messages:send': async (payload: {
    conversation_id: number;
    message: string;
    attachments?: { photo_id: number; attachment?: string }[];
    reply_to_id?: number | null;
  }) => {
    await delay(200);
    // The contract's bound (MICA-165): the server refuses a longer body outright rather than
    // truncating it, and a mock that took one would let a composer with no `maxlength` pass.
    if (payload.message.length > MESSAGE_BODY_MAX)
      throw new Error(`message must be ${MESSAGE_BODY_MAX} characters or fewer.`);
    const convId = payload.conversation_id;
    const conv = mockConversations.find((c) => c.id === convId);
    const msg: Message = {
      id: Math.floor(Math.random() * 1000000),
      conversation_id: convId,
      // As the server answers its sender (MICA-339): theirs, by their own membership id.
      mine: true,
      sender_id: conv?.participants?.find((p) => p.self)?.id ?? null,
      status: 'active',
      message: payload.message,
      // Kept on the row as the server keeps it now (MICA-209), so a thread re-read in the
      // browser still quotes what it quoted when it was sent.
      reply_to_id: payload.reply_to_id ?? null,
      // Hydrated the same way the real server does: `photo_id` resolves to the owning
      // row's full media, not just echoed back bare. Without this a freshly-sent
      // attachment rendered nothing until the next fetch re-hydrated it — invisible for
      // any kind a test sends and immediately asserts on, which a pre-seeded fixture
      // (already carrying `media`) never exercised.
      attachments: (payload.attachments || []).map((a, i) => ({
        ...a,
        id: i,
        media: mockMedia.find((p) => p.id === a.photo_id)
      })),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (!mockMessages[convId]) {
      mockMessages[convId] = [];
    }
    mockMessages[convId].push(msg);

    if (conv) {
      conv.last_message = msg;
      conv.updated_at = msg.created_at;
    }

    return msg;
  },
  /**
   * Editing and unsending, mocked against the same fixture array the thread reads.
   *
   * Both mutate `mockMessages` rather than answering `true` and leaving the fixture alone:
   * the store applies the server's reply optimistically, so a mock that only said "fine"
   * would still look right on screen and hide a reload that disagreed with it. The
   * ownership rule is mirrored too — a row that is not `mine` is refused here exactly as the
   * server refuses a message the caller did not send.
   */
  'messages:edit': async (data?: { id?: number; message?: string }) => {
    await delay(150);
    const text = (data?.message ?? '').trim();
    if (!text) throw new Error('A message needs some text. Unsend it instead of emptying it.');
    if ((data?.message ?? '').length > MESSAGE_BODY_MAX)
      throw new Error(`message must be ${MESSAGE_BODY_MAX} characters or fewer.`);
    for (const list of Object.values(mockMessages)) {
      const msg = list.find((m) => m.id === data?.id);
      if (!msg) continue;
      if (!msg.mine) throw new Error('That message is not yours to change.');
      if (msg.message === text)
        return { id: msg.id, conversation_id: msg.conversation_id, message: text };
      msg.message = text;
      msg.edited = true;
      msg.updated_at = new Date().toISOString();
      return { id: msg.id, conversation_id: msg.conversation_id, message: text, edited: true };
    }
    throw new Error('That message is not yours to change.');
  },
  'messages:delete': async (data?: { id?: number }) => {
    await delay(150);
    for (const [convId, list] of Object.entries(mockMessages)) {
      const index = list.findIndex((m) => m.id === data?.id);
      if (index === -1) continue;
      if (!list[index].mine) throw new Error('That message is not yours to change.');
      const wasNewest = index === list.length - 1;
      list.splice(index, 1);
      const conv = mockConversations.find((c) => c.id === Number(convId));
      // The list preview follows the thread: unsending the newest message must not leave
      // the conversation row quoting something nobody can open any more.
      if (conv && wasNewest) {
        conv.last_message = list[list.length - 1];
      }
      return true;
    }
    return false;
  },
  /**
   * Reactions on a message (MICA-143), the same three-verb shape as `reactToTarget`/
   * `unreactToTarget`/`getReactionsFor` (`services/accounts.ts`) but against
   * `mockMessageReactions` — a `messages`-owned fixture keyed on citizenid, not an
   * account. The mock's one caller identity is `'my-id'`, matching
   * `editMessage`/`deleteMessage`'s own ownership checks above.
   */
  'messages:react': ({ message_id, emoji }: { message_id: number; emoji: string }) => {
    if (
      !mockMessageReactions.some(
        (r) => r.messageId === message_id && r.citizenid === 'my-id' && r.emoji === emoji
      )
    ) {
      mockMessageReactions.push({ messageId: message_id, citizenid: 'my-id', emoji });
    }
    return true;
  },
  'messages:unreact': ({ message_id, emoji }: { message_id: number; emoji: string }) => {
    const at = mockMessageReactions.findIndex(
      (r) => r.messageId === message_id && r.citizenid === 'my-id' && r.emoji === emoji
    );
    if (at >= 0) mockMessageReactions.splice(at, 1);
    return true;
  },
  'messages:reactionsFor': ({ target_ids }: { target_ids: number[] }) => {
    const out: Record<number, { counts: Record<string, number>; mine: string[] }> = {};
    for (const id of target_ids) out[id] = { counts: {}, mine: [] };
    for (const row of mockMessageReactions) {
      if (!(row.messageId in out)) continue;
      out[row.messageId].counts[row.emoji] = (out[row.messageId].counts[row.emoji] ?? 0) + 1;
      if (row.citizenid === 'my-id') out[row.messageId].mine.push(row.emoji);
    }
    return out;
  },
  /**
   * `is_group` is deliberately ignored, exactly as the server ignores it (MICA-153).
   * It is derived from how many people are in the thread, so a mock that echoed the
   * payload back would let the browser and every Playwright run keep the semantics the
   * game no longer has — the shape of drift AGENTS.md §8 warns a mock can hide.
   */
  'conversations:create': async ({ participants }: { phone?: string; participants?: string[] }) => {
    await delay(300);
    // The caller plus the target, plus anyone else named — more than two is a group.
    const members = 2 + new Set(participants ?? []).size;
    return {
      id: Math.random(),
      is_group: members > 2,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      participants: []
    } as Conversation;
  },
  'conversations:read': async (data?: number | { conversation_id?: number }) => {
    await delay(200);
    const id = typeof data === 'number' ? data : data?.conversation_id;
    const conv = mockConversations.find((c) => c.id === id);
    if (conv) {
      conv.unread_count = 0;
      const myPart = conv.participants?.find((p) => p.self);
      if (myPart && conv.last_message) {
        myPart.last_read = conv.last_message.created_at;
      }
    }
    return true;
  },
  'conversations:archive': async (data?: { conversation_id?: number; status?: string }) => {
    await delay(200);
    // Reads `status`, which is what `store/messages.ts` actually sends. It used to read
    // `archived`, a key nothing ever set, so archiving was a silent no-op in the browser
    // and in Playwright — the route test only checks names, not payloads.
    const conv = mockConversations.find((c) => c.id === data?.conversation_id);
    if (conv && (data?.status === 'archived' || data?.status === 'active')) {
      conv.status = data.status;
    }
    return true;
  },
  'conversations:delete': async (data?: number | { conversation_id?: number }) => {
    await delay(200);
    const id = typeof data === 'number' ? data : data?.conversation_id;
    const idx = mockConversations.findIndex((c) => c.id === id);
    if (idx !== -1) {
      mockConversations.splice(idx, 1);
    }
    return true;
  },
  /**
   * Rename, as the server answers it since MICA-339: a contracted action, `true` only for the
   * thread's admin — the caller's own membership in every fixture here — and `false` otherwise.
   */
  'conversations:update': async (data?: { id?: number; name?: string }) => {
    await delay(200);
    const conv = mockConversations.find((c) => c.id === data?.id);
    const admin = conv?.participants?.some((p) => p.self && p.role === 'admin');
    if (!conv || !admin || !data?.name?.trim()) return false;
    conv.name = data.name.trim();
    return true;
  }
};
