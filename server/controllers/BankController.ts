import { TransactionRepository } from '../repositories/TransactionRepository';
import { ServerApp } from '../lib/ServerApp';
import { PlayerTransaction } from '@shared/types';

const transactionRepo = new TransactionRepository();
const app = new ServerApp<PlayerTransaction>('bank', transactionRepo, {
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

app.registerEvent('getTransactions', async (source, cbId, data, citizenid) => {
  const result = await transactionRepo.findByCitizenId(citizenid);

  let transactions = [];
  if (result && result.transactions) {
    const rawTransactions = result.transactions;
    transactions =
      typeof rawTransactions === 'string' ? JSON.parse(rawTransactions) : rawTransactions;
    transactions.sort((a: any, b: any) => b.time - a.time);
  }
  return transactions;
});
