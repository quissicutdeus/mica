// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';
export type { SendNotificationOptions } from './facets';

/**
 * OS Service Hook for sending toast notifications and system alerts.
 */
export function usePhoneNotification() {
  return guarded('usePhoneNotification').facets.phoneNotification();
}
