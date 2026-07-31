import { Repository } from '../lib/Repository';
import { Note } from '@shared/types';

export class NoteRepository extends Repository<Note> {
  protected tableName = 'gphone_notes';
}
