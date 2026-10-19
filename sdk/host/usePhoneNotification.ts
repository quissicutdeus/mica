// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';
export type { SendNotificationOptions } from './facets';

/**
 * OS Service Hook for sending toast notifications and system alerts.
 *
 * The app names itself, as it does for `useStorage`. Its notices are filed under that id,
 * `dismissNotification` takes down only its own, and `toast` shows only its own. In an
 * add-on the shell pins the id to the add-on's own, whatever is passed. Optional only so a
 * bundle written before the argument existed still compiles; a core app that names no app
 * has its notices filed under `'system'`.
 */
export function usePhoneNotification(appId?: string) {
  return guarded('usePhoneNotification', appId).facets.phoneNotification(appId);
}
