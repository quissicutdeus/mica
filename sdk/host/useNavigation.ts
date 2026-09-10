// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for phone navigation (opening apps, returning home, closing phone shell).
 *
 * `openApp` on an app the server owner has disabled (MICA-234) is refused the way an id
 * naming no app is: nothing opens and nothing throws. A deep link or a notification tap
 * reaches the same door, so it is refused there too.
 */
export function useNavigation() {
  return guarded('useNavigation').facets.navigation();
}
