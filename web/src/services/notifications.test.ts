// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { NotificationItem } from '@gphone/shared/types';
import {
  shadeNotifications,
  unreadCounts,
  markNotificationsOpened,
  markNotificationsRead
} from './notifications';
import * as fetchNuiModule from '../nui/fetchNui';

const item = (id: number, app = 'blabber'): NotificationItem => ({
  id,
  citizenid: 'me',
  app,
  kind: 'info',
  title: '@nightowl mentioned you',
  body: 'anyone up? @ada',
  avatar: null,
  deep_link: `blabber/${id}`,
  read_at: null,
  cleared_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
});

/** Every action the store sends, in order, so a missing half of the pair is visible. */
let sent: { action: string; data: unknown }[] = [];

beforeEach(() => {
  vi.restoreAllMocks();
  sent = [];
  shadeNotifications.set([]);
  unreadCounts.set({});
  /**
   * Recorded as `<service>:<action>` (MICA-213): every one of these now rides the generic
   * `svc` action, so the event name is the same string for all of them and what the store
   * actually asked for lives in the envelope.
   */
  vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation((method: string, payload?: unknown) => {
    const { service, action, data } = (payload ?? {}) as {
      service?: string;
      action?: string;
      data?: unknown;
    };
    const name = method === 'svc' ? `${service}:${action}` : method;
    sent.push({ action: name, data });
    if (name === 'notifications:getUnreadCounts') return Promise.resolve({} as never);
    return Promise.resolve(true as never);
  });
});

describe('markNotificationsOpened (MICA-96)', () => {
  it('takes a tapped notification out of Active rather than only marking it read', async () => {
    // The defect: Active is filtered on `cleared_at`, never on `read_at`, so a card that
    // had been tapped — and had already deep-linked into its content and cleared the
    // launcher badge — sat in Active unchanged, indefinitely.
    shadeNotifications.set([item(1), item(2)]);

    await markNotificationsOpened([1]);

    expect(get(shadeNotifications).map((n) => n.id)).toEqual([2]);
  });

  it('marks read before clearing, so the archived row records that it was seen', async () => {
    // Both are sent, and in this order: `restoreNotifications` puts a restored row back as
    // unread, so an archived row that was never marked read is indistinguishable from one
    // the player dismissed without looking.
    shadeNotifications.set([item(7)]);

    await markNotificationsOpened([7]);

    expect(sent.map((s) => s.action)).toEqual([
      'notifications:markAsRead',
      'notifications:clearNotifications',
      'notifications:getUnreadCounts'
    ]);
    expect(sent[0].data).toEqual({ ids: [7] });
    expect(sent[1].data).toEqual({ ids: [7] });
  });

  it('clears a whole conversation group in one pair of calls', async () => {
    // The shade opens every message in a conversation, not just the one tapped, so the
    // group must leave Active together — one straggler left behind is the same stale card.
    shadeNotifications.set([item(1), item(2), item(3)]);

    await markNotificationsOpened([1, 2]);

    expect(get(shadeNotifications).map((n) => n.id)).toEqual([3]);
    expect(sent.filter((s) => s.action === 'notifications:clearNotifications')).toHaveLength(1);
  });

  it('clears a notification that has already been read', async () => {
    // Reading and clearing are independent columns. Guarding the clear behind "was it
    // unread" — which is what the old tap handler did for the read half — would leave an
    // already-read card permanently stuck in Active.
    const read = { ...item(4), read_at: new Date().toISOString() };
    shadeNotifications.set([read]);

    await markNotificationsOpened([4]);

    expect(get(shadeNotifications)).toEqual([]);
  });

  it('sends nothing for an empty selection', async () => {
    shadeNotifications.set([item(1)]);

    await markNotificationsOpened([]);

    expect(sent).toEqual([]);
    expect(get(shadeNotifications).map((n) => n.id)).toEqual([1]);
  });

  it('leaves markNotificationsRead as the read-only half it always was', async () => {
    // `useNotifications().markRead` is still a real caller and must not start dismissing
    // things: reading is what an app does when it displays content, not when the player
    // acts on a shade card.
    shadeNotifications.set([item(9)]);

    await markNotificationsRead([9]);

    expect(get(shadeNotifications).map((n) => n.id)).toEqual([9]);
    expect(get(shadeNotifications)[0].read_at).toBeTruthy();
    expect(sent.map((s) => s.action)).toEqual([
      'notifications:markAsRead',
      'notifications:getUnreadCounts'
    ]);
  });
});
