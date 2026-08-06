import { writable, derived, get } from 'svelte/store';
import type { NotificationItem } from '@shared/types';
import { fetchNui } from '../nui/fetchNui';
import { subscribeAppEvent } from '../shell/state/appEvents';

export const shadeNotifications = writable<NotificationItem[]>([]);
export const unreadCounts = writable<Record<string, number>>({});

export const totalUnreadNotifications = derived(unreadCounts, ($counts) =>
  Object.values($counts).reduce((total, count) => total + count, 0)
);

export async function loadShadeNotifications(): Promise<void> {
  const items = await fetchNui<NotificationItem[]>(
    'getShadeNotifications',
    {},
    { defaultValue: [] }
  );
  shadeNotifications.set(items);
}

export async function loadNotificationHistory(): Promise<NotificationItem[]> {
  return await fetchNui<NotificationItem[]>('getNotificationHistory', {}, { defaultValue: [] });
}

export async function loadUnreadCounts(): Promise<void> {
  const counts = await fetchNui<Record<string, number>>(
    'getUnreadCounts',
    {},
    { defaultValue: {} }
  );
  unreadCounts.set(counts);
}

export async function markNotificationsRead(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await fetchNui('markNotificationRead', { ids }, { defaultValue: true });
  const now = new Date().toISOString();
  shadeNotifications.update((items) =>
    items.map((item) => (ids.includes(item.id) ? { ...item, read_at: item.read_at || now } : item))
  );
  await loadUnreadCounts();
}

export async function clearNotifications(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await fetchNui('clearNotifications', { ids }, { defaultValue: true });
  shadeNotifications.update((items) => items.filter((item) => !ids.includes(item.id)));
  await loadUnreadCounts();
}

export async function clearAllNotifications(appId?: string): Promise<void> {
  await fetchNui('clearAllNotifications', { appId }, { defaultValue: true });
  if (appId) {
    shadeNotifications.update((items) => items.filter((item) => item.app !== appId));
  } else {
    shadeNotifications.set([]);
  }
  await loadUnreadCounts();
}

export async function restoreNotifications(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await fetchNui('restoreNotifications', { ids }, { defaultValue: true });
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
