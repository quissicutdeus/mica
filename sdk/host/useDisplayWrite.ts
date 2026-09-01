// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for changing how big the phone is drawn on screen (MICA-127) — the
 * size, the motion preference, and the home screen grid. Separate from `useDisplay()`,
 * which only reads it; the window is Settings' business, not every app's.
 */
export function useDisplayWrite() {
  return guarded('useDisplayWrite').facets.displayWrite();
}
