import { registerFacet } from '../../current';
import { contacts as contactsService, favoriteContacts } from '../../../../services/contacts';

/**
 * OS Service Hook for accessing address book contacts and sharing contacts.
 */
export function contacts() {
  return {
    contactsStore: contactsService,
    favoriteContacts,
    addContact: (
      firstname: string,
      phone: string,
      lastname?: string,
      avatar?: string,
      favorite?: boolean
    ) => {
      return contactsService.add({
        firstname,
        lastname: lastname || '',
        phone,
        avatar,
        favorite: favorite ?? false
      });
    },
    shareContact: (firstname: string, phone: string, lastname?: string) => {
      return contactsService.share({ firstname, lastname: lastname || '', phone });
    }
  };
}

registerFacet('contacts', contacts);
