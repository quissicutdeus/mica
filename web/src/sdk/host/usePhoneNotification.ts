import { guarded } from './guard';
export type { SendNotificationOptions } from './facets';

/**
 * OS Service Hook for sending toast notifications and system alerts.
 */
export function usePhoneNotification() {
  return guarded('usePhoneNotification').facets.phoneNotification();
}
