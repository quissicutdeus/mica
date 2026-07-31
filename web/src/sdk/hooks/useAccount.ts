import { myPhoneNumber, fetchPhoneNumber } from '../../store/account';

/**
 * OS Service Hook for account state & phone number.
 */
export function useAccount() {
  return {
    myPhoneNumber,
    fetchPhoneNumber: () => fetchPhoneNumber()
  };
}
