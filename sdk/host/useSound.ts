// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * The phone's sound effects.
 */
export function useSound() {
  return guarded('useSound').facets.sound();
}
