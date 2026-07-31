import { notes } from '../../store/notes';
import type { Note } from '@shared/types';

/**
 * OS Service Hook for personal notes management.
 */
export function useNotes() {
  return {
    notesStore: notes,
    addNote: (title: string, content: string) => {
      const now = new Date().toISOString();
      return notes.add({ title, content, created_at: now, updated_at: now });
    },
    updateNote: (note: Note) => notes.update(note),
    deleteNote: (id: number) => notes.delete(id)
  };
}
