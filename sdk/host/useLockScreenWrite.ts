// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for changing the lock screen's settings (MICA-60) — the passcode and
 * the auto-lock policy. Separate from `useLockScreen()`, which only reads them.
 */
export function useLockScreenWrite() {
  return guarded('useLockScreenWrite').facets.lockScreenWrite();
}
