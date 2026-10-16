// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable, derived, get } from 'svelte/store';
import type { NotificationItem } from '@mica/shared/types';
import { DEFAULT_DEVICE } from '@mica/shared/devices';
import { activeDevice } from '../shell/state/device';
import { call, callOr } from '../nui/call';
import { notificationsContract } from '@mica/shared/contracts/notifications';
import { observeAppEvents } from '../shell/state/appEvents';
import { isPhoneOpen } from '../shell/state/phoneOpen';

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

/**
 * A failed read keeps the shade as it was and leaves `notificationsLoaded` alone: an empty
 * shade marked loaded reads as "No Activity Yet", and a refresh that failed used to wipe
 * real rows that way. The next mount or app-event refresh asks again.
 */
export async function loadShadeNotifications(): Promise<void> {
  try {
    const items = await call(notificationsContract, 'getShadeNotifications', undefined);
    if (!Array.isArray(items)) throw new Error('the shade answered something other than a list');
    shadeNotifications.set(items);
    notificationsLoaded.set(true);
  } catch (error) {
    console.warn('Could not load the notification shade; keeping what it showed.', error);
  }
}

export async function loadNotificationHistory(): Promise<NotificationItem[]> {
  return await callOr(notificationsContract, 'getNotificationHistory', undefined, []);
}

/** A failed read keeps the badges as they were rather than clearing every one to zero. */
export async function loadUnreadCounts(): Promise<void> {
  try {
    const counts = await call(notificationsContract, 'getUnreadCounts', undefined);
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
      throw new Error('unread counts were not a map');
    }
    unreadCounts.set(counts);
  } catch (error) {
    console.warn('Could not load unread counts; keeping the badges as they were.', error);
  }
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

/**
 * How long a push waits for others before the shade and the counts are read again.
 *
 * Every refresh is two NUI round trips and two server reads, and nothing bounds how often pushes
 * arrive: a job fan-out, a busy group chat, or another resource pushing through the public
 * export can land many in a second. Coalesced, a burst of any size costs one refresh, and a
 * sustained stream at most one per window plus one round trip.
 */
const REFRESH_COALESCE_MS = 250;

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let refreshAgain = false;

function scheduleRefresh(): void {
  if (refreshing) {
    // Read once more when this one lands: what it is fetching may predate the push.
    refreshAgain = true;
    return;
  }
  refreshTimer ??= setTimeout(() => void refreshFromPush(), REFRESH_COALESCE_MS);
}

/**
 * The phone's only (MICA-264). `notifications` is a phone service, refused from any other
 * device, and the stores above hold one identity, the active device's — so with the tablet up
 * a push does not ask, rather than asking as the tablet and being refused, or asking as the
 * phone and showing the phone's shade on the tablet. Checked when the refresh runs, not when the
 * push lands, since the device can change inside the window. A switch back to the phone re-runs
 * the bootstrap (`shell/state/deviceIdentity.ts`), which reads the counts again.
 */
async function refreshFromPush(): Promise<void> {
  refreshTimer = undefined;
  if (get(activeDevice) !== DEFAULT_DEVICE) return;
  refreshing = true;
  try {
    // MICA-365: with no frame up, nothing is showing the list — only the launcher badges'
    // counts are worth keeping current. The list is re-read by `NotificationShade`'s own mount,
    // which runs on every open (`PhoneFrame` sits inside `Shell.svelte`'s `{#if visible}`), so
    // a list skipped here is never shown stale. Read when the refresh runs, not when the push
    // landed, since the phone can open inside the window.
    await (get(isPhoneOpen)
      ? Promise.all([loadUnreadCounts(), loadShadeNotifications()])
      : loadUnreadCounts());
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      scheduleRefresh();
    }
  }
}

/**
 * Module-scope subscription so notifications and unread badges refresh on incoming app events.
 *
 * An observer (MICA-338): it sees every app's push without taking it, so an app that is not
 * mounted still has the event replayed when it is. Payload-blind since MICA-365 — this never
 * read one, and the `('*', '*')` observer cloned every payload for it anyway.
 *
 * Only a push that wrote a notification row refreshes (MICA-365). The shade and the counts are
 * read from those rows, so a live-location tick or a broadcast volume changes nothing either can
 * show, and used to cost two NUI round trips and two server reads each.
 */
observeAppEvents(({ persisted }) => {
  if (persisted) scheduleRefresh();
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
