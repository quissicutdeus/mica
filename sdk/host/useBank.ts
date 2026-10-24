// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for sending money. Separate from `useAccount()` — see
 * `services/bank.ts`'s own doc for why a balance-reading permission does not also imply
 * a money-moving one.
 *
 * **Core apps only** (MICA-441). `bank` is in `CORE_ONLY_PERMISSIONS`: `defineApp` refuses
 * a `core: false` manifest that declares it, the shell shuts a frame whose manifest does,
 * and the add-on barrel types this hook as returning nothing. An add-on reads a balance
 * through `useAccount()`, and moves no money.
 */
export function useBank() {
  return guarded('useBank').facets.bank();
}
