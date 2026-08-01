import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import type { Note } from '@shared/types';

function createNotesStore() {
  const { subscribe, set, update } = writable<Note[]>([]);

  return {
    subscribe,
    load: async () => {
      const data = await fetchNui<Note[]>('getNotes', null, { defaultValue: [] });
      if (Array.isArray(data)) {
        set(data);
      } else {
        console.error('Notes store received invalid data:', data);
        set([]);
      }
    },
    // No `defaultValue` on the writes, so `fetchNui` throws and the caller can react.
    // These used to swallow, which made a failed save indistinguishable from a good one.
    add: async (note: Omit<Note, 'id' | 'citizenid'>) => {
      const newNote = await fetchNui<Note>('createNote', note);
      update((n) => [...n, newNote]);
      return newNote;
    },
    update: async (note: Note) => {
      await fetchNui('updateNote', note);
      update((n) => n.map((c) => (c.id === note.id ? note : c)));
    },
    delete: async (id: number) => {
      await fetchNui('deleteNote', { id });
      update((n) => n.filter((c) => c.id !== id));
    }
  };
}

export const notes = createNotesStore();
