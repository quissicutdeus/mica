// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DarkchatMessage } from '@mica/shared/types';
import {
  mockDarkchatMessages,
  myDarkchatMember,
  type MockDarkchatMember,
  type MockDarkchatMessage
} from '../darkchat';
import type { MockHandler } from '../registry';

let nextMessageId = 100;

const requireMember = (channelId: number): MockDarkchatMember => {
  const me = myDarkchatMember(channelId);
  if (!me) throw new Error('You are not in that channel.');
  return me;
};

/** `mine` is computed for the reader, never stored — as the server answers it. */
const toMessage = (row: MockDarkchatMessage, me: MockDarkchatMember): DarkchatMessage => ({
  ...row,
  mine: row.member_id !== null && row.member_id === me.id
});

/**
 * Messages in a Dark Chat channel (MICA-254), answering `darkchatMessagesContract`. No retention
 * window here: the browser has no sweep, and nothing in the seed is old enough to need one.
 */
export const mocks: Record<string, MockHandler> = {
  /** Newest first, keyset-paged on `id DESC`, members only. */
  'darkchat_messages:list': ({
    channel_id,
    cursor,
    limit = 30
  }: {
    channel_id: number;
    cursor?: number | null;
    limit?: number;
  }) => {
    const me = requireMember(channel_id);
    const visible = mockDarkchatMessages
      .filter((m) => m.channel_id === channel_id && (cursor == null || m.id < cursor))
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return {
      rows: page.map((row) => toMessage(row, me)),
      nextCursor: hasMore ? page[page.length - 1].id : null
    };
  },

  'darkchat_messages:send': ({ channel_id, body }: { channel_id: number; body: string }) => {
    const me = requireMember(channel_id);
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '' || text.length > 500) throw new Error('A message is 1–500 characters.');
    const row: MockDarkchatMessage = {
      id: nextMessageId++,
      channel_id,
      member_id: me.id,
      alias: me.alias,
      bot: false,
      body: text,
      created_at: new Date().toISOString()
    };
    mockDarkchatMessages.push(row);
    return toMessage(row, me);
  }
};
