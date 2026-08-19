import { defineService } from '../lib/defineService';
import { CryptoHolding } from '@shared/types';

/**
 * Crypto Tracker: an owner-scoped log of coins a player says they hold.
 *
 * No price feed and no market data — this is a manual ledger, not a wallet or an
 * exchange. `amount` is a string rather than `int` because holdings are fractional
 * (0.125 BTC) and the schema has no decimal column type.
 */
export const crypto_tracker = defineService<CryptoHolding>({
  id: 'crypto_tracker',
  access: { read: 'owner', write: 'owner' },
  schema: {
    symbol: { type: 'string', length: 10, notNull: true },
    amount: { type: 'string', length: 30, notNull: true }
  }
});
