// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for active phone call management.
 */
export function useCall() {
  return guarded('useCall').facets.call();
}
