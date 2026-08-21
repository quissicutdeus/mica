import { derived } from 'svelte/store';
import {
  shadeNotifications,
  unreadCounts,
  totalUnreadNotifications,
  notificationsLoaded,
  loadShadeNotifications,
  loadUnreadCounts,
  markNotificationsRead,
  clearNotifications,
  clearAllNotifications
} from '../../services/notifications';

/**
 * SDK Hook providing OS persistent notifications, unread counts, and management actions.
 */
export function useNotifications(appId?: string) {
  const notificationsStore = derived(shadeNotifications, ($items) =>
    appId ? $items.filter((item) => item.app === appId) : $items
  );

  const unreadCount = derived(unreadCounts, ($counts) =>
    appId ? ($counts[appId] ?? 0) : Object.values($counts).reduce((sum, n) => sum + n, 0)
  );

  return {
    notificationsStore,
    unreadCount,
    totalUnread: totalUnreadNotifications,
    /** Shared across every caller: the shade is one list, so the first fetch is one fetch. */
    loaded: notificationsLoaded,
    load: async (): Promise<void> => {
      await loadShadeNotifications();
      await loadUnreadCounts();
    },
    markRead: markNotificationsRead,
    clear: clearNotifications,
    clearAll: (targetAppId?: string): Promise<void> => clearAllNotifications(targetAppId ?? appId)
  };
}
