import './inProcess/facets/messages';
import { guarded } from './guard';
export { unreadMessagesCount } from './inProcess/facets/messages';

/**
 * OS Service Hook for accessing SMS messaging.
 */
export function useMessages() {
  return guarded('useMessages').facets.messages();
}
