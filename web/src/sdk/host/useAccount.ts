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
import { assertCapability } from '../capability';

/**
 * OS Service Hook for account state, bank balance, transactions, & phone number.
 */
export function useAccount() {
  assertCapability('account', 'useAccount');
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
