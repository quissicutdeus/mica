import { ServerApp } from '../lib/ServerApp';
import { BankingBridge } from '../lib/BankingBridge';
import { Transaction } from '@shared/types';

/**
 * Bank: read-only, and backed by the banking resource's own export rather than its
 * database.
 *
 * There is no repository and no `defineServerApp` declaration here on purpose.
 * `player_transactions` belongs to the banking script, not to gPhone — declaring it
 * would generate DDL for someone else's table, and querying it directly would couple
 * the phone to their schema and read data their in-memory cache has already moved
 * past. `BankingBridge` adapts, the same way `FrameworkBridge` does for cores.
 */
const app = new ServerApp<Transaction>('bank', null, {
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

app.registerEvent('getTransactions', async (source, cbId, data, citizenid) => {
  return BankingBridge.getTransactions(citizenid);
});
