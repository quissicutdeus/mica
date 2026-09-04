// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import type { NotificationItem } from '@mica/shared/types';
import { groupNotificationsByConversation } from './notificationGrouping';

function makeItem(overrides: Partial<NotificationItem> & { id: number }): NotificationItem {
  return {
    citizenid: 'me',
    app: 'messages',
    kind: 'info',
    title: 'Someone',
    body: 'Hi',
    avatar: null,
    deep_link: null,
    read_at: null,
    cleared_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('groupNotificationsByConversation', () => {
  it('groups multiple items with the same title into one conversation', () => {
    const items = [
      makeItem({ id: 1, title: 'Ursula', created_at: '2026-01-01T00:00:00.000Z' }),
      makeItem({ id: 2, title: 'Ursula', created_at: '2026-01-01T00:01:00.000Z' }),
      makeItem({ id: 3, title: 'Ursula', created_at: '2026-01-01T00:02:00.000Z' })
    ];

    const groups = groupNotificationsByConversation(items);

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Ursula');
    expect(groups[0].items).toHaveLength(3);
  });

  it('keeps different titles as separate conversations', () => {
    const items = [makeItem({ id: 1, title: 'Ursula' }), makeItem({ id: 2, title: 'Franklin' })];

    const groups = groupNotificationsByConversation(items);

    expect(groups.map((g) => g.title).sort()).toEqual(['Franklin', 'Ursula']);
  });

  it('sets latest to the most recently created item in the conversation', () => {
    const items = [
      makeItem({ id: 1, title: 'Ursula', body: 'first', created_at: '2026-01-01T00:00:00.000Z' }),
      makeItem({
        id: 2,
        title: 'Ursula',
        body: 'newest',
        created_at: '2026-01-01T00:05:00.000Z'
      }),
      makeItem({
        id: 3,
        title: 'Ursula',
        body: 'middle',
        created_at: '2026-01-01T00:02:00.000Z'
      })
    ];

    const [group] = groupNotificationsByConversation(items);

    expect(group.latest.body).toBe('newest');
    // Newest-first within the conversation, not insertion order.
    expect(group.items.map((i) => i.body)).toEqual(['newest', 'middle', 'first']);
  });

  it('orders conversations by their own latest item, newest-first', () => {
    const items = [
      makeItem({ id: 1, title: 'Older convo', created_at: '2026-01-01T00:00:00.000Z' }),
      makeItem({ id: 2, title: 'Newer convo', created_at: '2026-01-01T00:10:00.000Z' })
    ];

    const groups = groupNotificationsByConversation(items);

    expect(groups.map((g) => g.title)).toEqual(['Newer convo', 'Older convo']);
  });

  it('returns an empty array for no items', () => {
    expect(groupNotificationsByConversation([])).toEqual([]);
  });
});
