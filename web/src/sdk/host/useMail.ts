import './inProcess/facets/mail';
import { guarded } from './guard';
export { unreadMailCount } from './inProcess/facets/mail';

/**
 * OS Service Hook for email messaging.
 */
export function useMail() {
  return guarded('useMail').facets.mail();
}
