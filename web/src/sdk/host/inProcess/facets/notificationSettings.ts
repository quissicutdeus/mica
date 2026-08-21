import { registerFacet } from '../../current';
import {
  toastsEnabled,
  notificationSoundEnabled,
  badgesEnabled
} from '../../../../shell/state/notificationSettings';

/**
 * OS Service Hook for Notification user preferences.
 */
export function notificationSettings() {
  return {
    toastsEnabled,
    notificationSoundEnabled,
    badgesEnabled
  };
}

registerFacet('notificationSettings', notificationSettings);
