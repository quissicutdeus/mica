import { derived } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { createCrudStore } from './createCrudStore';
import type { Contact } from '@shared/types';

/**
 * The one rule, applied to a create, an update and a share alike.
 *
 * Sharing says so in its own words: the message reaches the player as a toast, and
 * "required to share contact" is the difference between a form they can fix and an
 * action that will not go through.
 */
const requireNameAndPhone = (draft: Partial<Contact>, forSharing = false) => {
  if (draft.firstname?.trim() && draft.phone?.trim()) return;
  throw new Error(
    forSharing
      ? 'First name and phone number are required to share contact.'
      : 'First name and phone number are required.'
  );
};

const store = createCrudStore<
  Contact,
  Omit<Contact, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
>(
  'Contacts',
  {
    list: 'getContacts',
    create: 'createContact',
    update: 'updateContact',
    remove: 'deleteContact'
  },
  { validate: requireNameAndPhone }
);

export const contacts = {
  ...store,

  /**
   * Offer a contact to another player. Not a CRUD write — nothing enters this list.
   */
  share: async (payload: Partial<Contact> & { name?: string; phone: string }) => {
    const firstname = payload.firstname || payload.name?.split(' ')[0];
    requireNameAndPhone({ firstname, phone: payload.phone }, true);
    await fetchNui('shareContact', payload);
  }
};

export const favoriteContacts = derived(contacts, ($contacts) =>
  $contacts.filter((c) => c.favorite)
);
