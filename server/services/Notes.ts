import { defineService } from '../lib/defineService';
import { Note } from '@shared/types';

/**
 * Notes: the whole server half of the app.
 *
 * Replaces the hand-written NoteRepository + ServiceEndpoint pair. The schema drives the
 * `columns` allowlist, the `clientWritable` set, and the generated DDL in
 * the generated `gphone.sql` — so they cannot diverge.
 */
export const notes = defineService<Note>({
  id: 'notes',
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    title: { type: 'string', length: 255 },
    content: 'text'
  },
  indexes: [{ name: 'citizenid_status_updated', columns: ['citizenid', 'status', 'updated_at'] }]
});
