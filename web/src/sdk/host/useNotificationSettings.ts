import {
  toastsEnabled,
  notificationSoundEnabled,
  badgesEnabled
} from '../../shell/state/notificationSettings';

/**
 * OS Service Hook for Notification user preferences.
 */
export function useNotificationSettings() {
  return {
    toastsEnabled,
    notificationSoundEnabled,
    badgesEnabled
  };
}
