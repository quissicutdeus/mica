import { writable, derived } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import type { Mail } from '@shared/types';

function createMailStore() {
  const { subscribe, set, update } = writable<Mail[]>([]);

  return {
    subscribe,
    load: async () => {
      try {
        const data = await fetchNui<Mail[]>('getMail', null, { defaultValue: [] });
        if (Array.isArray(data)) {
          set(data);
        } else {
          console.error('Mail store received invalid data:', data);
          set([]);
        }
      } catch (e) {
        console.error('Failed to load emails:', e);
        set([]);
      }
    },
    markAsRead: async (id: number) => {
      try {
        update((mails) => mails.map((m) => (m.id === id ? { ...m, read: true } : m)));
        await fetchNui('markAsRead', { id });
      } catch (e) {
        console.error('Failed to mark email as read:', e);
      }
    },
    archive: async (id: number, archiveState: boolean = true) => {
      try {
        const newStatus = archiveState ? 'archived' : 'active';
        update((mails) => mails.map((m) => (m.id === id ? { ...m, status: newStatus } : m)));
        await fetchNui('archiveMail', { id, archive: archiveState });
      } catch (e) {
        console.error('Failed to archive email:', e);
      }
    },
    delete: async (id: number) => {
      try {
        update((mails) => mails.filter((m) => m.id !== id));
        await fetchNui('deleteMail', { id });
      } catch (e) {
        console.error('Failed to delete email:', e);
      }
    },
    addReceivedMail: (newMail: Mail) => {
      update((mails) => {
        const idExists = newMail.id && mails.some((m) => m.id === newMail.id);
        const safeId = idExists || !newMail.id ? Date.now() : newMail.id;
        return [{ ...newMail, id: safeId, status: newMail.status || 'active' }, ...mails];
      });
    }
  };
}

export const mailStore = createMailStore();

export const unreadMailCount = derived(
  mailStore,
  ($mailStore) => $mailStore.filter((m) => !m.read && m.status === 'active').length
);
