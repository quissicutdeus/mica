import { Repository } from '../lib/Repository';
import { Database } from '../lib/Database';
import { Mail } from '@shared/types';

export class MailRepository extends Repository<Mail> {
  protected tableName = 'gphone_mail';

  protected columns = [
    'id',
    'citizenid',
    'sender',
    'sender_address',
    'subject',
    'content',
    'status',
    'read',
    'created_at',
    'updated_at'
  ];

  // Mail is never authored by the phone's owner — every mutation goes through a
  // named method below or `SendSystemEmail`, so the generic write path is closed.
  protected clientWritable: readonly string[] = [];

  async findActiveByCitizenId(citizenid: string): Promise<Mail[]> {
    const query = `SELECT * FROM ${this.tableName} WHERE citizenid = ? AND status = 'active' ORDER BY created_at DESC`;
    return await Database.query<Mail[]>(query, [citizenid]);
  }

  async markAsRead(id: number, citizenid: string): Promise<boolean> {
    const query = `UPDATE ${this.tableName} SET \`read\` = 1 WHERE id = ? AND citizenid = ?`;
    return await Database.update(query, [id, citizenid]);
  }

  async findAllByCitizenId(citizenid: string): Promise<Mail[]> {
    const query = `SELECT * FROM ${this.tableName} WHERE citizenid = ? AND status != 'deleted' ORDER BY created_at DESC`;
    return await Database.query<Mail[]>(query, [citizenid]);
  }

  async archive(id: number, citizenid: string, archiveState: boolean = true): Promise<boolean> {
    const newStatus = archiveState ? 'archived' : 'active';
    const query = `UPDATE ${this.tableName} SET status = ? WHERE id = ? AND citizenid = ?`;
    return await Database.update(query, [newStatus, id, citizenid]);
  }

  // `delete` is inherited: the base implementation is already an ownership-scoped
  // soft delete. The previous override accepted an optional citizenid and silently
  // fell back to an unscoped UPDATE when it was missing.
}
