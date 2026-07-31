import { writable, derived } from 'svelte/store';
import { fetchNui } from '../utils/fetchNui';
import type { Contact } from '@shared/types';

function createContactsStore() {
  const { subscribe, set, update } = writable<Contact[]>([]);

  return {
    subscribe,
    load: async () => {
      const data = await fetchNui<Contact[]>('getContacts', null, { defaultValue: [] });
      if (Array.isArray(data)) {
        set(data);
      } else {
        console.error('Contacts store received invalid data:', data);
        set([]);
      }
    },
    add: async (contact: Omit<Contact, 'id' | 'citizenid' | 'created_at' | 'updated_at'>) => {
      if (!contact.firstname?.trim() || !contact.phone?.trim()) {
        console.error('Failed to create contact: missing required firstname or phone');
        throw new Error('First name and phone number are required.');
      }
      try {
        const newContact = await fetchNui<Contact>('createContact', contact);
        if (newContact) {
          update((n) => [...n, newContact]);
          return newContact;
        }
      } catch (e) {
        console.error('Failed to create contact:', e);
        throw e;
      }
    },
    update: async (contact: Contact) => {
      if (!contact.firstname?.trim() || !contact.phone?.trim()) {
        console.error('Failed to update contact: missing required firstname or phone');
        throw new Error('First name and phone number are required.');
      }
      try {
        await fetchNui('updateContact', contact);
        update((n) => n.map((c) => (c.id === contact.id ? contact : c)));
      } catch (e) {
        console.error('Failed to update contact:', e);
      }
    },
    delete: async (id: number) => {
      try {
        await fetchNui('deleteContact', { id });
        update((n) => n.filter((c) => c.id !== id));
      } catch (e) {
        console.error('Failed to delete contact:', e);
      }
    },
    share: async (payload: Partial<Contact> & { name?: string; phone: string }) => {
      const firstname = payload.firstname || payload.name?.split(' ')[0];
      if (!firstname?.trim() || !payload.phone?.trim()) {
        console.error('Failed to share contact: missing required name or phone');
        throw new Error('First name and phone number are required to share contact.');
      }
      try {
        await fetchNui('shareContact', payload);
      } catch (e) {
        console.error('Failed to share contact:', e);
      }
    }
  };
}

export const contacts = createContactsStore();
export const favoriteContacts = derived(contacts, ($contacts) =>
  $contacts.filter((c) => c.favorite)
);
