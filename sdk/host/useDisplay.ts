// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * How big the phone is drawn on screen — read-only. Changing it (size, motion
 * preference, or the home grid) is `useDisplayWrite` (MICA-127).
 */
export function useDisplay() {
  return guarded('useDisplay').facets.display();
}
