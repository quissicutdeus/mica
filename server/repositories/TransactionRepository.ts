import { Repository } from '../lib/Repository';
import { Database } from '../lib/Database';
import { PlayerTransaction } from '@shared/types';

export class TransactionRepository extends Repository<PlayerTransaction> {
  protected tableName = 'player_transactions';

  // Framework-owned table, not a gphone_ table: no status column, so the generic
  // soft-delete path does not apply here.
  protected columns = ['id', 'citizenid', 'transactions'];

  async findByCitizenId(citizenid: string): Promise<PlayerTransaction | null> {
    const query = `SELECT * FROM \`${this.tableName}\` WHERE \`id\` = ?`;
    return await Database.single<PlayerTransaction>(query, [citizenid]);
  }
}
