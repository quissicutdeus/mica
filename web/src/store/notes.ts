import { writable } from 'svelte/store';
import { fetchNui } from '../utils/fetchNui';
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
    add: async (note: Omit<Note, 'id' | 'citizenid'>) => {
      try {
        const newNote = await fetchNui<Note>('createNote', note);
        if (newNote) {
          update((n) => [...n, newNote]);
          return newNote;
        }
      } catch (e) {
        console.error('Failed to create note:', e);
        throw e;
      }
    },
    update: async (note: Note) => {
      try {
        await fetchNui('updateNote', note);
        update((n) => n.map((c) => (c.id === note.id ? note : c)));
      } catch (e) {
        console.error('Failed to update note:', e);
      }
    },
    delete: async (id: number) => {
      try {
        await fetchNui('deleteNote', { id });
        update((n) => n.filter((c) => c.id !== id));
      } catch (e) {
        console.error('Failed to delete note:', e);
      }
    }
  };
}

export const notes = createNotesStore();
