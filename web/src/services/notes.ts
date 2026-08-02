import { createCrudStore, byNewest } from './createCrudStore';
import type { Note } from '@shared/types';

export const notes = createCrudStore<Note, Omit<Note, 'id' | 'citizenid'>>(
  'Notes',
  { list: 'getNotes', create: 'createNote', update: 'updateNote', remove: 'deleteNote' },
  // Most recently edited first. The list used to arrive in whatever order the server
  // returned and be re-sorted in the component, which meant a note saved while the list
  // was on screen jumped only after the next reload.
  { sort: byNewest<Note>('updated_at') }
);
