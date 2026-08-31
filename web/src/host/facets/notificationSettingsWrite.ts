import { registerFacet } from '../../sdk/host/current';
import {
  toastsEnabled,
  notificationSoundEnabled,
  badgesEnabled
} from '../../shell/state/notificationSettings';
import {
  clearAppNotificationPolicy,
  dndEnabled,
  setAppNotificationPolicy
} from '../../shell/state/notificationPolicy';

/**
 * Implementation of the `useNotificationSettingsWrite` facet — see the
 * `useNotificationSettingsWrite` hook doc for the usage contract. Split out of
 * `notificationSettings` (MICA-127): reading whether the player has muted an app and
 * deciding it for them — including flipping the master switches Settings' Notifications
 * pane calls `.set()` on directly today — are not the same ask.
 */
export function notificationSettingsWrite() {
  return {
    setToastsEnabled: (value: boolean): void => {
      toastsEnabled.set(value);
    },
    setNotificationSoundEnabled: (value: boolean): void => {
      notificationSoundEnabled.set(value);
    },
    setBadgesEnabled: (value: boolean): void => {
      badgesEnabled.set(value);
    },
    setDndEnabled: (value: boolean): void => {
      dndEnabled.set(value);
    },
    setAppNotificationPolicy,
    clearAppNotificationPolicy
  };
}

registerFacet('notificationSettingsWrite', notificationSettingsWrite);
