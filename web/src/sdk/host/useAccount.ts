import './inProcess/facets/account';
import { guarded } from './guard';

/**
 * OS Service Hook for account state, bank balance, transactions, & phone number.
 */
export function useAccount() {
  return guarded('useAccount').facets.account();
}
