import {
  toastsEnabled,
  notificationSoundEnabled,
  badgesEnabled
} from '../../shell/state/notificationSettings';
import { assertCapability } from '../capability';

/**
 * OS Service Hook for Notification user preferences.
 */
export function useNotificationSettings() {
  assertCapability('notification-settings', 'useNotificationSettings');
  return {
    toastsEnabled,
    notificationSoundEnabled,
    badgesEnabled
  };
}
