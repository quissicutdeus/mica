import { defineServerApp } from '../lib/defineServerApp';
import { Note } from '@shared/types';

/**
 * Notes: the whole server half of the app.
 *
 * Replaces the hand-written NoteRepository + ServerApp pair. The schema drives the
 * `columns` allowlist, the `clientWritable` set, and the generated DDL in
 * sql/apps/notes.sql — so they cannot diverge.
 */
export const notes = defineServerApp<Note>({
  id: 'notes',
  scope: 'owner',
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    title: { type: 'string', length: 255 },
    content: 'text'
  },
  // Matches the index the hand-written gphone_notes table already carries.
  indexes: [['citizenid', 'status', 'updated_at']]
});
