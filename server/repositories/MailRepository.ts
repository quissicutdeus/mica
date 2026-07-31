import { Repository } from '../lib/Repository';
import { Database } from '../lib/Database';
import { Mail } from '@shared/types';

export class MailRepository extends Repository<Mail> {
  protected tableName = 'gphone_mail';

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

  async delete(id: number | string, citizenid?: string): Promise<boolean> {
    if (citizenid) {
      const query = `UPDATE ${this.tableName} SET status = 'deleted' WHERE id = ? AND citizenid = ?`;
      return await Database.update(query, [id, citizenid]);
    }
    const query = `UPDATE ${this.tableName} SET status = 'deleted' WHERE id = ?`;
    return await Database.update(query, [id]);
  }
}
