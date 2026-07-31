import { contacts } from '../../store/contacts';

/**
 * OS Service Hook for accessing address book contacts and sharing contacts.
 */
export function useContacts() {
  return {
    contactsStore: contacts,
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
