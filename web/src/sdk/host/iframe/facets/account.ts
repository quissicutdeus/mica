import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/account').account>;

export function account(): Twin {
  return {
    myPhoneNumber: store('account', [], 'myPhoneNumber', ''),
    bankBalance: store('account', [], 'bankBalance', 0),
    transactions: store('account', [], 'transactions', []),
    transactionsLoaded: store('account', [], 'transactionsLoaded', false),
    citizenid: store('account', [], 'citizenid', ''),
    fetchPhoneNumber: fn('account', [], 'fetchPhoneNumber'),
    fetchBalance: fn('account', [], 'fetchBalance'),
    fetchTransactions: fn('account', [], 'fetchTransactions'),
    fetchCitizenId: fn('account', [], 'fetchCitizenId')
  } as unknown as Twin;
}
registerFacet('account', account);
