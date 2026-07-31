import { Repository } from '../lib/Repository';
import { Contact } from '@shared/types';

export class ContactRepository extends Repository<Contact> {
  protected tableName = 'gphone_contacts';
}
