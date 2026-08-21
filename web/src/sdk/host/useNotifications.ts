import './inProcess/facets/notifications';
import { guarded } from './guard';

/**
 * SDK Hook providing OS persistent notifications, unread counts, and management actions.
 */
export function useNotifications(appId?: string) {
  return guarded('useNotifications', appId).facets.notifications(appId);
}
