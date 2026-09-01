// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for phone navigation (opening apps, returning home, closing phone shell).
 */
export function useNavigation() {
  return guarded('useNavigation').facets.navigation();
}
