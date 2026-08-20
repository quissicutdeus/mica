import { createCrudStore, byNewest } from '@gphone/sdk';
import type { CryptoHolding } from '@shared/types';

/**
 * Crypto Tracker's own data layer, inside the app — see `apps/notes/store.ts` for why:
 * an add-on cannot add a hook to the SDK or a store to core's `services/` directory.
 *
 * `service: 'crypto_tracker'` routes through the one generic NUI callback, so
 * `shared/routes.ts` needs no row and core never learns this app exists.
 *
 * Built at module scope, same reasoning as Notes: a manifest must not import this file
 * statically (it would drag the still-initialising `@gphone/sdk` barrel in behind it),
 * so `preload` reaches it with `import('./store')` instead.
 */
export const cryptoTracker = createCrudStore<
  CryptoHolding,
  Pick<CryptoHolding, 'symbol' | 'amount'>
>(
  'Hodlr',
  { list: 'get', create: 'create', update: 'update', remove: 'delete' },
  {
    service: 'crypto_tracker',
    sort: byNewest<CryptoHolding>('updated_at'),
    validate: (draft) => {
      const symbol = 'symbol' in draft ? draft.symbol : undefined;
      const amount = 'amount' in draft ? draft.amount : undefined;
      if (!symbol?.trim()) throw new Error('Enter a coin symbol.');
      if (!amount?.trim() || Number.isNaN(Number(amount))) {
        throw new Error('Enter a valid amount.');
      }
    }
  }
);

export function useCryptoTracker() {
  return {
    cryptoTracker,
    addHolding: (symbol: string, amount: string) => cryptoTracker.add({ symbol, amount }),
    deleteHolding: (id: number) => cryptoTracker.delete(id)
  };
}
