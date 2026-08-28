import { registerFacet } from '../../current';
import {
  toastsEnabled,
  notificationSoundEnabled,
  badgesEnabled
} from '../../../../shell/state/notificationSettings';
import {
  appNotificationPolicies,
  appPolicyStore,
  clearAppNotificationPolicy,
  customisedNotificationApps,
  dndEnabled,
  setAppNotificationPolicy
} from '../../../../shell/state/notificationPolicy';

/**
 * OS Service Hook for Notification user preferences.
 *
 * The three globals are the master switches; `dndEnabled` and the per-app policies are the
 * MICA-63 layer over them. All of it is presentation policy evaluated on the phone — the
 * server keeps writing the row and keeps pushing the envelope either way, which is the whole
 * design and is argued out in `shell/state/notificationPolicy.ts`.
 */
export function notificationSettings() {
  return {
    toastsEnabled,
    notificationSoundEnabled,
    badgesEnabled,
    dndEnabled,
    appNotificationPolicies,
    customisedNotificationApps,
    appPolicyStore,
    setAppNotificationPolicy,
    clearAppNotificationPolicy
  };
}

registerFacet('notificationSettings', notificationSettings);
