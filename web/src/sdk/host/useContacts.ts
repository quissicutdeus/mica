import './inProcess/facets/contacts';
import { guarded } from './guard';

/**
 * OS Service Hook for accessing address book contacts and sharing contacts.
 */
export function useContacts() {
  return guarded('useContacts').facets.contacts();
}
