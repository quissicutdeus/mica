// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * SDK Hook providing OS persistent notifications, unread counts, and management actions.
 */
export function useNotifications(appId?: string) {
  return guarded('useNotifications', appId).facets.notifications(appId);
}
