// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for changing notification preferences (MICA-127) — the master
 * switches (toasts, sound, badges, Do Not Disturb) and the per-app policy. Separate from
 * `useNotificationSettings()`, which only reads it; see its own doc for why every member
 * throws inside a sandboxed add-on regardless of what its manifest declares.
 */
export function useNotificationSettingsWrite() {
  return guarded('useNotificationSettingsWrite').facets.notificationSettingsWrite();
}
