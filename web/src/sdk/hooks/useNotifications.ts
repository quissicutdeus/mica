import { derived } from 'svelte/store';
import {
  shadeNotifications,
  unreadCounts,
  totalUnreadNotifications,
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
    load: async (): Promise<void> => {
      await loadShadeNotifications();
      await loadUnreadCounts();
    },
    markRead: markNotificationsRead,
    clear: clearNotifications,
    clearAll: (targetAppId?: string): Promise<void> => clearAllNotifications(targetAppId ?? appId)
  };
}
