// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for Notification user preferences — read-only. Changing any of it is
 * `useNotificationSettingsWrite` (MICA-127).
 */
export function useNotificationSettings() {
  return guarded('useNotificationSettings').facets.notificationSettings();
}
