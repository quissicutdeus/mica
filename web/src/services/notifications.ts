// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, derived } from 'svelte/store';
import type { NotificationItem } from '@mica/shared/types';
import { callOr } from '../nui/call';
import { notificationsContract } from '@mica/shared/contracts/notifications';
import { subscribeAppEvent } from '../shell/state/appEvents';

export const shadeNotifications = writable<NotificationItem[]>([]);
export const unreadCounts = writable<Record<string, number>>({});

/**
 * Whether the first shade fetch has come back.
 *
 * An empty list and a list that has not arrived yet are two different statements, and every list
 * in the phone owes the reader the right one (§11.6). Without this a notifications tab renders
 * "No Activity Yet" over a request still in flight.
 */
export const notificationsLoaded = writable(false);

export const totalUnreadNotifications = derived(unreadCounts, ($counts) =>
  Object.values($counts).reduce((total, count) => total + count, 0)
);

export async function loadShadeNotifications(): Promise<void> {
  const items = await callOr(notificationsContract, 'getShadeNotifications', undefined, []);
  shadeNotifications.set(items);
  notificationsLoaded.set(true);
}

export async function loadNotificationHistory(): Promise<NotificationItem[]> {
  return await callOr(notificationsContract, 'getNotificationHistory', undefined, []);
}

export async function loadUnreadCounts(): Promise<void> {
  const counts = await callOr(notificationsContract, 'getUnreadCounts', undefined, {});
  unreadCounts.set(counts);
}

export async function markNotificationsRead(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await callOr(notificationsContract, 'markAsRead', { ids }, true);
  const now = new Date().toISOString();
  shadeNotifications.update((items) =>
    items.map((item) => (ids.includes(item.id) ? { ...item, read_at: item.read_at || now } : item))
  );
  await loadUnreadCounts();
}

/**
 * The player opened these — mark them read *and* clear them out of Active.
 *
 * Tapping a card is an act of handling it: it deep-links straight into the thing the card
 * was about, so leaving the card sitting in Active afterwards asks the player to dismiss a
 * notification they have already acted on (MICA-96). Reading alone did not do it — Active
 * is filtered on `cleared_at`, never on `read_at`, so a tapped card only stopped counting
 * towards the launcher badge and otherwise sat there unchanged.
 *
 * Cleared rather than deleted, so it lands in Archived and the shade's existing restore path
 * can put it back. Read is set *before* cleared, and both are sent, because the archived row
 * should record that it was seen rather than dismissed unread — `restoreNotifications` puts a
 * restored row back as unread, which is the state a restore should be undoing to.
 *
 * One `loadUnreadCounts` for the pair rather than one each: composing `markNotificationsRead`
 * and `clearNotifications` would cost two extra NUI round trips per tap, and the first of
 * them would report a count the second immediately invalidates.
 */
export async function markNotificationsOpened(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await callOr(notificationsContract, 'markAsRead', { ids }, true);
  await callOr(notificationsContract, 'clearNotifications', { ids }, true);
  shadeNotifications.update((items) => items.filter((item) => !ids.includes(item.id)));
  await loadUnreadCounts();
}

export async function clearNotifications(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await callOr(notificationsContract, 'clearNotifications', { ids }, true);
  shadeNotifications.update((items) => items.filter((item) => !ids.includes(item.id)));
  await loadUnreadCounts();
}

export async function clearAllNotifications(appId?: string): Promise<void> {
  await callOr(notificationsContract, 'clearAllNotifications', { appId }, true);
  if (appId) {
    shadeNotifications.update((items) => items.filter((item) => item.app !== appId));
  } else {
    shadeNotifications.set([]);
  }
  await loadUnreadCounts();
}

export async function restoreNotifications(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await callOr(notificationsContract, 'restoreNotifications', { ids }, true);
  await loadShadeNotifications();
  await loadUnreadCounts();
}

// Module-scope subscription so notifications and unread badges refresh on incoming app events
subscribeAppEvent('*', '*', () => {
  void loadUnreadCounts();
  void loadShadeNotifications();
});

/** Add a local notification item to the shade store (used for toasts and client notifications). */
export function addNotificationItem(item: {
  app?: string;
  title?: string;
  body?: string;
  avatar?: string;
  deepLink?: string;
}): NotificationItem {
  const newItem: NotificationItem = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    citizenid: 'me',
    app: item.app || 'system',
    kind: 'info',
    title: item.title || 'Notification',
    body: item.body || '',
    avatar: item.avatar || null,
    deep_link: item.deepLink || null,
    read_at: null,
    cleared_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  shadeNotifications.update((items) => [newItem, ...items]);
  unreadCounts.update((counts) => ({
    ...counts,
    [newItem.app]: (counts[newItem.app] || 0) + 1
  }));

  return newItem;
}
