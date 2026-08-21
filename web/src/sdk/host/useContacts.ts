import { contacts, favoriteContacts } from '../../services/contacts';
import { assertCapability } from '../capability';

/**
 * OS Service Hook for accessing address book contacts and sharing contacts.
 */
export function useContacts() {
  assertCapability('contacts', 'useContacts');
  return {
    contactsStore: contacts,
    favoriteContacts,
    addContact: (
      firstname: string,
      phone: string,
      lastname?: string,
      avatar?: string,
      favorite?: boolean
    ) => {
      return contacts.add({
        firstname,
        lastname: lastname || '',
        phone,
        avatar,
        favorite: favorite ?? false
      });
    },
    shareContact: (firstname: string, phone: string, lastname?: string) => {
      return contacts.share({ firstname, lastname: lastname || '', phone });
    }
  };
}
