import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const wallet = vi.hoisted(() => ({ bank: 0 }));
const player = vi.hoisted(() => ({
  getMoney: vi.fn(),
  removeMoney: vi.fn(),
  addMoney: vi.fn()
}));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) =>
      src === 1
        ? {
            citizenid: 'CID_CALLER',
            source: 1,
            getMoney: player.getMoney,
            removeMoney: player.removeMoney,
            addMoney: player.addMoney
          }
        : null
  }
}));

const market = vi.hoisted(() => ({ price: 10, ready: true }));
/** Snapshot rows come from storage, so they are available whether the market is open or not. */
const HISTORY = [{ price: 9, recorded_at: '2026-08-29T00:00:00Z' }];
vi.mock('../services/HodlrMarket', () => ({
  getCurrentPrice: () => market.price,
  isMarketReady: () => market.ready,
  getPriceHistory: async () => HISTORY
}));

import { __resetRateLimits } from '../lib/rateLimit';
import '../services/Hodlr';

/**
 * Hodlr's `buy` and `sell`, which are the only things that ever move a holding — the
 * service disables all four generic CRUD actions and declares `write: 'server'`.
 *
 * The point of most of this file is MICA-99: the UI's Confirm guard is a courtesy, and
 * a modified client can emit `gphone:server:hodlr:sell` with any quantity it likes
 * (AGENTS.md §2.9). So the refusal is asserted at the server, with the bank credit and
 * the SQL both checked — a refusal that still paid out would be worse than no refusal.
 */
describe('hodlr: buy and sell', () => {
  const BUY = 'gphone:server:hodlr:buy';
  const SELL = 'gphone:server:hodlr:sell';

  const HOLDING = {
    id: 7,
    citizenid: 'CID_CALLER',
    quantity: 5,
    status: 'active',
    created_at: 'now',
    updated_at: 'now'
  };

  const call = async (event: string, data: unknown, src = 1) => {
    (globalThis as any).source = src;
    (globalThis as any).emitNet = vi.fn();
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no handler for ${event}`);
    await handler('cb-1', data);
    return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
  };

  /** The `UPDATE ... quantity = quantity - ?` calls, in order. */
  const decrements = () =>
    dbMock.update.mock.calls.filter(([sql]: [string]) => /`quantity` - \?/.test(sql));
  const increments = () =>
    dbMock.update.mock.calls.filter(([sql]: [string]) => /`quantity` \+ \?/.test(sql));

  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimits();
    market.price = 10;
    market.ready = true;
    wallet.bank = 1000;
    player.getMoney.mockImplementation(() => wallet.bank);
    player.removeMoney.mockImplementation(() => true);
    player.addMoney.mockImplementation(() => true);
    // findOrCreateHolding: the player already owns 5 gCoin.
    dbMock.query.mockResolvedValue([{ ...HOLDING }]);
    dbMock.update.mockResolvedValue(1);
  });

  describe('sell', () => {
    it('refuses a quantity larger than the holding and pays out nothing', async () => {
      // The conditional decrement matches no row, which is how the database — not the
      // read above it — is what actually refuses.
      dbMock.update.mockResolvedValue(0);

      const reply = await call(SELL, { quantity: 999 });

      expect(reply).toEqual({ ok: false, reason: 'insufficient_holdings' });
      expect(player.addMoney).not.toHaveBeenCalled();
    });

    it('guards the decrement with the quantity being sold, not just the id', async () => {
      await call(SELL, { quantity: 3 });

      const [[sql, params]] = decrements();
      expect(sql).toMatch(/`quantity` >= \?/);
      expect(params).toEqual([3, HOLDING.id, 3]);
    });

    it('credits the bank and reports the remaining quantity on success', async () => {
      const reply = await call(SELL, { quantity: 5 });

      expect(player.addMoney).toHaveBeenCalledWith('bank', 50);
      expect(reply).toEqual({ ok: true, quantity: 0, price: 10, proceeds: 50 });
    });

    it('refunds the coins when the bank credit fails after the decrement committed', async () => {
      player.addMoney.mockReturnValue(false);

      const reply = await call(SELL, { quantity: 2 });

      expect(reply).toEqual({ ok: false, reason: 'credit_failed' });
      expect(increments()).toEqual([
        ['UPDATE `gphone_hodlr` SET `quantity` = `quantity` + ? WHERE `id` = ?', [2, HOLDING.id]]
      ]);
    });

    it.each([
      ['a fractional quantity', { quantity: 1.5 }],
      ['a negative quantity', { quantity: -5 }],
      ['zero', { quantity: 0 }],
      ['a missing quantity', {}],
      ['a non-scalar quantity', { quantity: [3] }],
      ['a non-object payload', 'sell them all']
    ])('rejects %s before touching the holding', async (_label, payload) => {
      const reply = await call(SELL, payload);

      expect(reply).toEqual({ error: 'A valid quantity is required.' });
      expect(dbMock.update).not.toHaveBeenCalled();
      expect(player.addMoney).not.toHaveBeenCalled();
    });
  });

  describe('buy', () => {
    it('refuses when the bank balance will not cover the cost, without debiting', async () => {
      wallet.bank = 10;

      const reply = await call(BUY, { quantity: 4 });

      expect(reply).toEqual({ ok: false, reason: 'insufficient_funds' });
      expect(player.removeMoney).not.toHaveBeenCalled();
      expect(increments()).toEqual([]);
    });

    it('does not credit coins when the debit itself fails', async () => {
      player.removeMoney.mockReturnValue(false);

      const reply = await call(BUY, { quantity: 2 });

      expect(reply).toEqual({ ok: false, reason: 'debit_failed' });
      expect(increments()).toEqual([]);
    });

    it('debits the cost and credits the coins as a relative increment', async () => {
      const reply = await call(BUY, { quantity: 3 });

      expect(player.removeMoney).toHaveBeenCalledWith('bank', 30);
      expect(increments()).toEqual([
        ['UPDATE `gphone_hodlr` SET `quantity` = `quantity` + ? WHERE `id` = ?', [3, HOLDING.id]]
      ]);
      expect(reply).toEqual({ ok: true, quantity: 8, price: 10, cost: 30 });
    });

    it('rejects a fractional quantity before pricing it', async () => {
      const reply = await call(BUY, { quantity: 0.5 });

      expect(reply).toEqual({ error: 'A valid quantity is required.' });
      expect(player.removeMoney).not.toHaveBeenCalled();
    });
  });

  describe('portfolio and price', () => {
    it('creates an empty holding on first contact rather than reporting nothing', async () => {
      dbMock.query.mockResolvedValue([]);
      dbMock.insert.mockResolvedValue(42);

      const reply = await call('gphone:server:hodlr:portfolio', {});

      expect(reply).toEqual({ ready: true, quantity: 0, currentPrice: 10, currentValue: 0 });
    });

    it('quotes the live price with the history behind it', async () => {
      const reply = await call('gphone:server:hodlr:price', {});

      expect(reply).toEqual({ ready: true, current: 10, history: HISTORY });
    });
  });

  /**
   * MICA-130, part 4: a trade is capped by value, the way `Bank.ts` caps a send.
   *
   * `requirePositiveInt` accepts any positive integer, so the effective ceiling on a buy was
   * the player's whole bank balance and on a sell their whole holding — one call moved the
   * entire position. The rate limiter bounds how many calls a modified client makes, never
   * what one of them is worth.
   */
  describe('per-trade value cap', () => {
    const withConvar = (value: string, run: () => Promise<void>) => {
      const previous = (globalThis as any).GetConvar;
      (globalThis as any).GetConvar = () => value;
      return run().finally(() => {
        (globalThis as any).GetConvar = previous;
      });
    };

    it('refuses a buy worth more than the cap before any money or row is touched', async () => {
      // 5001 x 10 is over the 50000 default. The bank balance is 1000, so a reply of
      // `insufficient_funds` here would mean the cap was checked after the wallet — and the
      // cap is the check that has to come first, since it is the one a rich player still hits.
      const reply = await call(BUY, { quantity: 5001 });

      expect(reply).toEqual({ ok: false, reason: 'exceeds_limit' });
      expect(player.getMoney).not.toHaveBeenCalled();
      expect(player.removeMoney).not.toHaveBeenCalled();
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('refuses a sell worth more than the cap before the decrement', async () => {
      const reply = await call(SELL, { quantity: 5001 });

      expect(reply).toEqual({ ok: false, reason: 'exceeds_limit' });
      expect(dbMock.update).not.toHaveBeenCalled();
      expect(player.addMoney).not.toHaveBeenCalled();
    });

    it('allows a trade worth exactly the cap', async () => {
      wallet.bank = 1_000_000;

      const reply = await call(BUY, { quantity: 5000 });

      expect(reply).toEqual({ ok: true, quantity: 5005, price: 10, cost: 50_000 });
    });

    it('honours the convar rather than only the default', async () => {
      await withConvar('100', async () => {
        expect(await call(BUY, { quantity: 11 })).toEqual({ ok: false, reason: 'exceeds_limit' });
        expect(await call(SELL, { quantity: 11 })).toEqual({ ok: false, reason: 'exceeds_limit' });
        expect(await call(BUY, { quantity: 10 })).toMatchObject({ ok: true, cost: 100 });
      });
    });

    it('falls back to the default when the convar is not a usable number', async () => {
      await withConvar('nonsense', async () => {
        expect(await call(BUY, { quantity: 5001 })).toEqual({ ok: false, reason: 'exceeds_limit' });
        expect(await call(BUY, { quantity: 1 })).toMatchObject({ ok: true });
      });
    });

    it('caps a quantity so large it would otherwise reach SQL as a number', async () => {
      // `requirePositiveInt` is happy with 1e20; the cap is what stops it, and it stops it
      // before the value is ever handed to the database or the framework's money API.
      const reply = await call(SELL, { quantity: 1e20 });

      expect(reply).toEqual({ ok: false, reason: 'exceeds_limit' });
      expect(dbMock.update).not.toHaveBeenCalled();
    });
  });

  /**
   * MICA-130, part 1, at the service boundary: no trade settles against a price the market
   * has not checked against storage yet. An unrestored price is the opening constant, which
   * is the number the whole restart exploit was built on.
   */
  describe('a market that has not opened', () => {
    beforeEach(() => {
      market.ready = false;
    });

    it('refuses a buy without debiting anyone', async () => {
      const reply = await call(BUY, { quantity: 1 });

      expect(reply).toEqual({ ok: false, reason: 'market_unavailable' });
      expect(player.removeMoney).not.toHaveBeenCalled();
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('refuses a sell without paying anyone', async () => {
      const reply = await call(SELL, { quantity: 1 });

      expect(reply).toEqual({ ok: false, reason: 'market_unavailable' });
      expect(player.addMoney).not.toHaveBeenCalled();
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    /**
     * Neither read settles money, so these are not the vulnerability `buy`/`sell` are. They
     * were still wrong: while the market is closed `getCurrentPrice()` is the opening
     * constant the whole MICA-130 exploit was built on, so the UI stated a price with
     * total confidence that every trade would then be refused at, and an add-on reading
     * `price` got the same number. The quote is withheld and the state named instead.
     */
    it('withholds the quote from price rather than answering with the opening constant', async () => {
      const reply = await call('gphone:server:hodlr:price', {});

      expect(reply).toEqual({ ready: false, current: 0, history: HISTORY });
    });

    it('withholds the valuation from portfolio but still discloses the holding', async () => {
      const reply = await call('gphone:server:hodlr:portfolio', {});

      expect(reply).toEqual({ ready: false, quantity: 5, currentPrice: 0, currentValue: 0 });
    });

    it('keeps serving the chart, which reads storage rather than the unrestored price', async () => {
      const reply = (await call('gphone:server:hodlr:price', {})) as { history: unknown[] };

      expect(reply.history).toEqual(HISTORY);
    });
  });
});
