import { registerFacet } from '../../../../sdk/host/current';
import {
  myPhoneNumber,
  fetchPhoneNumber,
  bankBalance,
  transactions,
  transactionsLoaded,
  citizenid,
  fetchBalance,
  fetchTransactions,
  fetchCitizenId
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
    citizenid,
    fetchPhoneNumber: () => fetchPhoneNumber(),
    fetchBalance: () => fetchBalance(),
    fetchTransactions: () => fetchTransactions(),
    fetchCitizenId: () => fetchCitizenId()
  };
}

registerFacet('account', account);
