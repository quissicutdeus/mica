import { Repository } from '../lib/Repository';
import { Contact } from '@shared/types';

export class ContactRepository extends Repository<Contact> {
  protected tableName = 'gphone_contacts';

  protected columns = [
    'id',
    'citizenid',
    'firstname',
    'lastname',
    'phone',
    'email',
    'avatar',
    'favorite',
    'status',
    'created_at',
    'updated_at'
  ];

  protected clientWritable = ['firstname', 'lastname', 'phone', 'email', 'avatar', 'favorite'];

  protected clientFilterable = ['phone', 'favorite'];
}
