// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for account state, bank balance, transactions, & phone number.
 */
export function useAccount() {
  return guarded('useAccount').facets.account();
}
