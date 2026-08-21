import './inProcess/facets/notificationSettings';
import { guarded } from './guard';

/**
 * OS Service Hook for Notification user preferences.
 */
export function useNotificationSettings() {
  return guarded('useNotificationSettings').facets.notificationSettings();
}
