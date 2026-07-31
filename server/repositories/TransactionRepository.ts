import { Repository } from '../lib/Repository';
import { Database } from '../lib/Database';
import { PlayerTransaction } from '@shared/types';

export class TransactionRepository extends Repository<PlayerTransaction> {
  protected tableName = 'player_transactions';

  async findByCitizenId(citizenid: string): Promise<PlayerTransaction | null> {
    const query = `SELECT * FROM ${this.tableName} WHERE id = ?`;
    return await Database.single<PlayerTransaction>(query, [citizenid]);
  }
}
