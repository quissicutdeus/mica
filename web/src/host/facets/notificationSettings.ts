// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import {
  toastsEnabled,
  notificationSoundEnabled,
  badgesEnabled
} from '../../shell/state/notificationSettings';
import {
  appNotificationPolicies,
  appPolicyStore,
  customisedNotificationApps,
  dndEnabled
} from '../../shell/state/notificationPolicy';

/**
 * OS Service Hook for Notification user preferences — read-only.
 *
 * The three globals are the master switches; `dndEnabled` and the per-app policies are the
 * MICA-63 layer over them. All of it is presentation policy evaluated on the phone — the
 * server keeps writing the row and keeps pushing the envelope either way, which is the whole
 * design and is argued out in `shell/state/notificationPolicy.ts`.
 *
 * Changing any of it is `useNotificationSettingsWrite` (MICA-127) — letting an app that
 * only wants to know whether it has been muted also mute a rival, unmute itself, or flip
 * Do Not Disturb was never the intent of this hook, just its shape until now.
 */
export function notificationSettings() {
  return {
    toastsEnabled,
    notificationSoundEnabled,
    badgesEnabled,
    dndEnabled,
    appNotificationPolicies,
    customisedNotificationApps,
    appPolicyStore
  };
}

registerFacet('notificationSettings', notificationSettings);
