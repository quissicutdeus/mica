// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NotificationItem } from '@mica/shared/types';
import { mockConversations, mockEmails } from '../data';
import type { MockHandler } from '../registry';
import { mockBlabs } from '../social';

/**
 * Notification previews are derived from the fixture they link to, not typed out by hand a
 * second time. `body` used to be an invented paraphrase — "GET DOWN HERE. NOW." for Trevor,
 * a line that appears nowhere in his actual thread — so the shade showed one message and
 * opening the conversation showed the real last message underneath it. Deriving from
 * `mockConversations`/`mockEmails`/`mockBlabs` means the two views can't disagree, the same
 * way `Email from <sender>` already matched `server/services/Mail.ts` by construction.
 */
const messageNotification = (
  id: number,
  conversationId: number,
  ageMs: number
): NotificationItem => {
  const conv = mockConversations.find((c) => c.id === conversationId);
  const created_at = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    citizenid: 'mock_citizenid',
    app: 'messages',
    kind: 'info',
    title: conv?.name ?? 'Messages',
    body: conv?.last_message?.message ?? '',
    avatar: null,
    deep_link: `messages?conversationId=${conversationId}`,
    read_at: null,
    cleared_at: null,
    created_at,
    updated_at: created_at
  };
};

const mailNotification = (id: number, mailId: number, ageMs: number): NotificationItem => {
  const mail = mockEmails.find((m) => m.id === mailId);
  const created_at = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    citizenid: 'mock_citizenid',
    app: 'mail',
    kind: 'email',
    title: `Email from ${mail?.sender ?? 'Mail'}`,
    body: mail?.subject ?? '',
    avatar: null,
    deep_link: `mail?mailId=${mailId}`,
    read_at: null,
    cleared_at: null,
    created_at,
    updated_at: created_at
  };
};

/** `blabId` must name a Blab that actually mentions the player, not merely one that exists. */
const mentionNotification = (id: number, blabId: number, ageMs: number): NotificationItem => {
  const blab = mockBlabs.find((b) => b.id === blabId);
  const created_at = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    citizenid: 'mock_citizenid',
    app: 'blabber',
    kind: 'mention',
    title: `@${blab?.handle ?? 'someone'} mentioned you`,
    body: blab?.body ?? '',
    avatar: null,
    deep_link: `blabber?blabId=${blabId}`,
    read_at: null,
    cleared_at: null,
    created_at,
    updated_at: created_at
  };
};

/**
 * Every row here names a fixture that exists and points at its real id.
 *
 * They did not. The titles were invented in isolation — "Sarah Connor", "Mike Ross",
 * "Boss" — while the links read `conversationId=1..3`, which are Ursula, the Union
 * Depository crew and Trevor Philips. So tapping Sarah Connor opened a conversation with
 * a stranger, and `mailId=5`/`6` named mail that does not exist at all, leaving Mail on
 * the inbox forever because `useDeepLink` returns false and is retried.
 *
 * That is not a cosmetic fixture problem. §8's whole point about mocks is that they make
 * a missing layer invisible; a mock whose ids do not resolve does the opposite and makes
 * a *working* layer look broken. Either way you cannot trust `pnpm dev`. When adding a
 * notification here, take the title and the id from the fixture it points at.
 *
 * The shapes match what the server pushes — `Email from <sender>` with the subject as the
 * body is exactly `server/services/Mail.ts`.
 */
const mockNotifications: NotificationItem[] = [
  {
    id: 1,
    citizenid: 'mock_citizenid',
    app: 'settings',
    kind: 'info',
    title: 'Developer Tools',
    body: 'Developer Tools unlocked successfully.',
    avatar: null,
    deep_link: 'settings',
    read_at: null,
    cleared_at: null,
    created_at: new Date(Date.now() - 60000).toISOString(),
    updated_at: new Date(Date.now() - 60000).toISOString()
  },
  // Blab 2 ("anyone up? @ada") is the one post in the fixture that actually mentions @ada,
  // one of the two accounts the player owns (`mockOwnedAccountIds`) — a mention notification
  // has to point at a mention, not merely a post that exists. It also exercises the per-app
  // filter and the deep link an in-app notifications tab reads.
  mentionNotification(7, 2, 90000),
  messageNotification(2, 1, 120000),
  messageNotification(3, 3, 300000),
  messageNotification(4, 4, 600000),
  mailNotification(5, 1, 900000),
  mailNotification(6, 2, 1200000)
];

export const mocks: Record<string, MockHandler> = {
  // Persistent Notifications
  'notifications:getShadeNotifications': async () => mockNotifications.filter((n) => !n.cleared_at),
  'notifications:getNotificationHistory': async () =>
    mockNotifications.filter((n) => n.cleared_at !== null),
  'notifications:getUnreadCounts': async () => {
    const counts: Record<string, number> = {};
    for (const n of mockNotifications) {
      if (!n.cleared_at && !n.read_at) {
        counts[n.app] = (counts[n.app] || 0) + 1;
      }
    }
    return counts;
  },
  'notifications:markAsRead': async (data?: { ids?: number[] }) => {
    const ids = data?.ids || [];
    const now = new Date().toISOString();
    mockNotifications.forEach((n) => {
      if (ids.includes(n.id)) n.read_at = now;
    });
    return true;
  },
  'notifications:clearNotifications': async (data?: { ids?: number[] }) => {
    const ids = data?.ids || [];
    const now = new Date().toISOString();
    mockNotifications.forEach((n) => {
      if (ids.includes(n.id)) n.cleared_at = now;
    });
    return true;
  },
  'notifications:clearAllNotifications': async (data?: { appId?: string }) => {
    const now = new Date().toISOString();
    mockNotifications.forEach((n) => {
      if (!data?.appId || n.app === data.appId) n.cleared_at = now;
    });
    return true;
  },
  'notifications:restoreNotifications': async (data?: { ids?: number[] }) => {
    const ids = data?.ids || [];
    mockNotifications.forEach((n) => {
      if (ids.includes(n.id)) {
        n.cleared_at = null;
        n.read_at = null;
      }
    });
    return true;
  }
};
