// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for the Developer Tools reveal.
 */
export function useDevTools() {
  return guarded('useDevTools').facets.devTools();
}
