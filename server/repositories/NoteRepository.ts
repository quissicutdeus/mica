import { Repository } from '../lib/Repository';
import { Note } from '@shared/types';

export class NoteRepository extends Repository<Note> {
  protected tableName = 'gphone_notes';

  protected columns = ['id', 'citizenid', 'title', 'content', 'status', 'created_at', 'updated_at'];

  protected clientWritable = ['title', 'content'];
}
