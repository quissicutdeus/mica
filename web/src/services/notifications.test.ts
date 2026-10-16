// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import type { NotificationItem } from '@mica/shared/types';
import {
  shadeNotifications,
  unreadCounts,
  markNotificationsOpened,
  markNotificationsRead
} from './notifications';
import * as fetchNuiModule from '../nui/fetchNui';
import { clearAppEvents, deliverAppEvent, subscribeAppEvent } from '../shell/state/appEvents';
import { setActiveDevice } from '../shell/state/device';
import { openDevice } from '../shell/state/phoneOpen';

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

/**
 * MICA-264: an app event refreshes the shade and the badges, and both read `notifications`, a
 * phone service the server refuses from the tablet. The stores hold the active device's
 * identity, so with the tablet up a push asks nothing at all — neither as the tablet (refused)
 * nor as the phone (the phone's shade under the tablet).
 */
/**
 * MICA-338: a real push — an ordinary app's envelope through the real `deliverAppEvent`, never a
 * delivery under app `'*'`, which is the shape that hid this subscriber never firing at all.
 */
const push = (app = 'blabber', event = 'mention', persisted = true) =>
  deliverAppEvent({ app, event, payload: {}, at: Date.now(), persisted });
const reads = () =>
  sent
    .filter((s) => s.action.startsWith('notifications:get'))
    .map((s) => s.action)
    .sort();
const PAIR = ['notifications:getShadeNotifications', 'notifications:getUnreadCounts'];

describe('a push refreshes the shade and the badges (MICA-338)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The shade list is only re-read with a frame up (MICA-365); these are about the refresh.
    openDevice.set('phone');
  });
  afterEach(async () => {
    // Drain the refresh a test left scheduled, so it cannot land in the next one.
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    openDevice.set(null);
    clearAppEvents('blabber');
    clearAppEvents('mail');
  });

  it('refreshes both on a push for an ordinary app', async () => {
    push();
    await vi.runAllTimersAsync();

    expect(reads()).toEqual(PAIR);
  });

  it('coalesces a burst of pushes from several apps into one refresh', async () => {
    for (let i = 0; i < 20; i++) push(i % 2 ? 'mail' : 'blabber', 'received');
    await vi.runAllTimersAsync();

    expect(reads()).toEqual(PAIR);
  });

  it('runs exactly one more refresh for pushes that land while one is in flight', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const base = vi.mocked(fetchNuiModule.fetchNui).getMockImplementation()!;
    let first = true;
    vi.mocked(fetchNuiModule.fetchNui).mockImplementation(async (method, payload) => {
      const result = base(method, payload);
      if (first && (payload as { action?: string })?.action === 'getShadeNotifications') {
        first = false;
        await held;
      }
      return result;
    });

    push();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads()).toEqual(PAIR);

    // In flight: these must neither start a second refresh now nor be lost.
    for (let i = 0; i < 5; i++) push();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads()).toEqual(PAIR);

    release();
    await vi.runAllTimersAsync();
    expect(reads()).toEqual([...PAIR, ...PAIR].sort());
  });

  it('does not take the event from its own app, which still replays it on mount', async () => {
    push('blabber', 'mention');
    await vi.runAllTimersAsync();

    const seen: boolean[] = [];
    const off = subscribeAppEvent('blabber', 'mention', (e) => seen.push(e.replayed));
    off();
    expect(seen).toEqual([true]);
  });
});

/**
 * MICA-264: both reads are of `notifications`, a phone service the server refuses from the
 * tablet. The stores hold the active device's identity, so with the tablet up a push asks
 * nothing at all — neither as the tablet (refused) nor as the phone (the phone's shade under the
 * tablet).
 */
describe('a push while another device is up (MICA-264)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    setActiveDevice('phone');
    clearAppEvents('blabber');
    clearAppEvents('mail');
  });

  it('asks nothing while the tablet is up', async () => {
    setActiveDevice('tablet');
    push();
    await vi.runAllTimersAsync();

    expect(reads()).toEqual([]);
  });

  it('asks nothing if the tablet comes up before the coalesced refresh runs', async () => {
    push();
    setActiveDevice('tablet');
    await vi.runAllTimersAsync();

    expect(reads()).toEqual([]);
  });
});

/**
 * MICA-365: the shade and the counts are read from notification rows, so only a push that wrote
 * one refreshes, and with no frame up only the counts — the list is re-read by the shade's own
 * mount on the next open.
 */
describe('only a stored push refreshes, and a closed phone reads the counts alone (MICA-365)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    openDevice.set(null);
    clearAppEvents('blabber');
    clearAppEvents('liveloc');
  });

  it('reads nothing for a push that wrote no row', async () => {
    openDevice.set('phone');
    for (let i = 0; i < 10; i++) push('liveloc', 'tick', false);
    await vi.runAllTimersAsync();

    expect(reads()).toEqual([]);
  });

  it('reads both for a stored push with the phone open', async () => {
    openDevice.set('phone');
    push('liveloc', 'tick', false);
    push('blabber', 'mention', true);
    await vi.runAllTimersAsync();

    expect(reads()).toEqual(PAIR);
  });

  it('reads only the counts for a stored push with the phone closed', async () => {
    openDevice.set(null);
    push('blabber', 'mention', true);
    await vi.runAllTimersAsync();

    expect(reads()).toEqual(['notifications:getUnreadCounts']);
  });

  it('decides open or closed when the refresh runs, not when the push landed', async () => {
    openDevice.set(null);
    push('blabber', 'mention', true);
    openDevice.set('phone');
    await vi.runAllTimersAsync();

    expect(reads()).toEqual(PAIR);
  });
});
