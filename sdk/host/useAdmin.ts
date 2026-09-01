// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for the player's admin status.
 */
export function useAdmin() {
  return guarded('useAdmin').facets.admin();
}
