import {
  myPhoneNumber,
  fetchPhoneNumber,
  bankBalance,
  transactions,
  citizenid,
  fetchBalance,
  fetchTransactions,
  fetchCitizenId
} from '../../services/account';

/**
 * OS Service Hook for account state, bank balance, transactions, & phone number.
 */
export function useAccount() {
  return {
    myPhoneNumber,
    bankBalance,
    transactions,
    citizenid,
    fetchPhoneNumber: () => fetchPhoneNumber(),
    fetchBalance: () => fetchBalance(),
    fetchTransactions: () => fetchTransactions(),
    fetchCitizenId: () => fetchCitizenId()
  };
}
