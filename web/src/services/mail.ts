import { derived, get } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { createCrudStore } from './createCrudStore';
import type { Mail } from '@shared/types';

const store = createCrudStore<Mail>('Mail', {
  list: 'getMail',
  remove: 'deleteMail'
});

export const mailStore = {
  ...store,

  /**
   * Mail is read-only from the phone's side apart from these two flags, so they are the
   * app's own verbs rather than a generic update. Both wait for the server before the
   * list changes: they used to patch first, which meant a failed archive left the
   * message hidden until the next reload put it back.
   */
  markAsRead: async (id: number) => {
    await fetchNui('markAsRead', { id });
    store.patch(id, { read: true });
  },

  archive: async (id: number, archive: boolean = true) => {
    await fetchNui('archiveMail', { id, archive });
    store.patch(id, { status: archive ? 'archived' : 'active' });
  },

  /** Arrives by push, so there is nothing to tell the server. */
  addReceivedMail: (incoming: Mail) => {
    const current = get(store);
    const clashes = incoming.id && current.some((m) => m.id === incoming.id);
    const id = clashes || !incoming.id ? Date.now() : incoming.id;
    store.set([{ ...incoming, id, status: incoming.status || 'active' }, ...current]);
  }
};

export const unreadMailCount = derived(
  mailStore,
  ($mailStore) => $mailStore.filter((m) => !m.read && m.status === 'active').length
);
