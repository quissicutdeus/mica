// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import {
  myPhoneNumber,
  fetchPhoneNumber,
  bankBalance,
  transactions,
  transactionsLoaded,
  historySource,
  fetchBalance,
  fetchTransactions
} from '../../services/account';

/**
 * OS Service Hook for account state, bank balance, transactions, & phone number.
 */
export function account() {
  return {
    myPhoneNumber,
    bankBalance,
    transactions,
    transactionsLoaded,
    historySource,
    fetchPhoneNumber: () => fetchPhoneNumber(),
    fetchBalance: () => fetchBalance(),
    fetchTransactions: () => fetchTransactions()
  };
}

registerFacet('account', account);
