import { writable, derived } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
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
      // No `defaultValue`, so `fetchNui` throws on a failed write and the caller's catch
      // runs. It used to swallow, so this returned `undefined` and the UI announced
      // success for a contact that was never created.
      const newContact = await fetchNui<Contact>('createContact', contact);
      update((n) => [...n, newContact]);
      return newContact;
    },
    update: async (contact: Contact) => {
      if (!contact.firstname?.trim() || !contact.phone?.trim()) {
        console.error('Failed to update contact: missing required firstname or phone');
        throw new Error('First name and phone number are required.');
      }
      await fetchNui('updateContact', contact);
      update((n) => n.map((c) => (c.id === contact.id ? contact : c)));
    },
    delete: async (id: number) => {
      await fetchNui('deleteContact', { id });
      update((n) => n.filter((c) => c.id !== id));
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
