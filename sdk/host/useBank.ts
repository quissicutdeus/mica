// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for sending money. Separate from `useAccount()` — see
 * `services/bank.ts`'s own doc for why a balance-reading permission does not also imply
 * a money-moving one.
 */
export function useBank() {
  return guarded('useBank').facets.bank();
}
