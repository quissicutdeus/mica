// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { quoteSpread } from '../services/Hodlr';

/**
 * Hodlr's `buy` and `sell`, which are the only things that ever move a holding — the
 * service disables all four generic CRUD actions and declares `write: 'server'`.
 *
 * The point of most of this file is MICA-99: the UI's Confirm guard is a courtesy, and
 * a modified client can emit `gos:server:hodlr:sell` with any quantity it likes
 * (AGENTS.md §2.9). So the refusal is asserted at the server, with the bank credit and
 * the SQL both checked — a refusal that still paid out would be worse than no refusal.
 */
describe('hodlr: buy and sell', () => {
  const BUY = 'gos:server:hodlr:buy';
  const SELL = 'gos:server:hodlr:sell';

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
      // Mid is 10; the default 2% spread settles a sell at floor(10 * 0.99) = 9, not the
      // bare mid — see `describe('the buy/sell spread')` for the spread math itself.
      const reply = await call(SELL, { quantity: 5 });

      expect(player.addMoney).toHaveBeenCalledWith('bank', 45);
      expect(reply).toEqual({ ok: true, quantity: 0, price: 9, proceeds: 45 });
    });

    it('refunds the coins when the bank credit fails after the decrement committed', async () => {
      player.addMoney.mockReturnValue(false);

      const reply = await call(SELL, { quantity: 2 });

      expect(reply).toEqual({ ok: false, reason: 'credit_failed' });
      expect(increments()).toEqual([
        ['UPDATE `gos_hodlr` SET `quantity` = `quantity` + ? WHERE `id` = ?', [2, HOLDING.id]]
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

      // The rule is the contract's now, so the message names the field rather than restating
      // the rule. What it refuses is unchanged, plus a ceiling `requirePositiveInt` never had.
      expect(reply).toMatchObject({ error: expect.any(String) });
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
      // Mid is 10; the default 2% spread settles a buy at ceil(10 * 1.01) = 11, not the
      // bare mid — see `describe('the buy/sell spread')` for the spread math itself.
      const reply = await call(BUY, { quantity: 3 });

      expect(player.removeMoney).toHaveBeenCalledWith('bank', 33);
      expect(increments()).toEqual([
        ['UPDATE `gos_hodlr` SET `quantity` = `quantity` + ? WHERE `id` = ?', [3, HOLDING.id]]
      ]);
      expect(reply).toEqual({ ok: true, quantity: 8, price: 11, cost: 33 });
    });

    /**
     * MICA-132, and the one item in that ticket that is not a race.
     *
     * `sell` has always refunded the coins when the bank credit fails after the decrement
     * committed — the test a few lines above. `buy` is the mirror and had nothing: it
     * awaited the increment, ignored the boolean it answered, and carried no `try`/`catch`,
     * so a throw after the debit had committed left the player charged with no coins and a
     * toast telling them the trade failed.
     *
     * Not attacker-profitable — it burns the player's own money — which is exactly why it
     * would have arrived as a bug report rather than as an exploit.
     */
    it('refunds the debit when the increment throws after the money was taken', async () => {
      dbMock.update.mockRejectedValueOnce(new Error('connection dropped'));

      const reply = await call(BUY, { quantity: 3 });

      expect(reply).toEqual({ ok: false, reason: 'credit_failed' });
      // Buy settles at 11 (mid 10 plus the default 2% spread), not the bare mid.
      expect(player.removeMoney).toHaveBeenCalledWith('bank', 33);
      // The money comes back, and it is the same amount that was taken.
      expect(player.addMoney).toHaveBeenCalledWith('bank', 33);
    });

    it('refunds the debit when the increment matched no row', async () => {
      // A holding that vanished between `findOrCreateHolding` and the increment. The update
      // answering false is not an error the driver raises, so ignoring the boolean lost the
      // money just as silently as a throw did.
      dbMock.update.mockResolvedValueOnce(false);

      const reply = await call(BUY, { quantity: 3 });

      expect(reply).toEqual({ ok: false, reason: 'credit_failed' });
      expect(player.addMoney).toHaveBeenCalledWith('bank', 33);
    });

    it('says so loudly when it can neither credit coins nor give the money back', async () => {
      // Nothing further the handler can do, so a server owner reading the log is the only
      // remaining route to making the player whole. Swallowing it would hide the one case
      // where money really is gone.
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      dbMock.update.mockResolvedValueOnce(false);
      player.addMoney.mockReturnValue(false);

      const reply = await call(BUY, { quantity: 3 });

      expect(reply).toEqual({ ok: false, reason: 'credit_failed' });
      expect(logged).toHaveBeenCalled();
      expect(String(logged.mock.calls.at(-1)?.[0])).toMatch(/refund/i);
      logged.mockRestore();
    });

    it('rejects a fractional quantity before pricing it', async () => {
      const reply = await call(BUY, { quantity: 0.5 });

      expect(reply).toMatchObject({ error: expect.stringContaining('quantity') });
      expect(player.removeMoney).not.toHaveBeenCalled();
    });
  });

  describe('portfolio and price', () => {
    it('creates an empty holding on first contact rather than reporting nothing', async () => {
      dbMock.query.mockResolvedValue([]);
      dbMock.insert.mockResolvedValue(42);

      const reply = await call('gos:server:hodlr:portfolio', {});

      expect(reply).toEqual({ ready: true, quantity: 0, currentPrice: 10, currentValue: 0 });
    });

    it('quotes the live price with the history behind it', async () => {
      // MICA-147/149: `buyPrice`/`sellPrice` are the spread's two quotes around `current`,
      // the mid/reference price the chart still plots unchanged.
      const reply = await call('gos:server:hodlr:price', {});

      expect(reply).toEqual({
        ready: true,
        current: 10,
        buyPrice: 11,
        sellPrice: 9,
        history: HISTORY
      });
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
    /**
     * Spread-neutral for this whole block, not just inside `withConvar` — MICA-147/149's
     * spread reads its own convar independently of the trade-max one, and this block's
     * numbers (`price: 10`, `cost: 50_000`, and the exact-boundary quantities) were all
     * chosen against a flat mid price. Forcing the spread convar to `'0'` here keeps this
     * describe testing exactly what its name says — the cap — without also becoming a
     * second, accidental test of the spread math that `describe('the buy/sell spread')`
     * below already owns.
     */
    beforeEach(() => {
      (globalThis as any).GetConvar = (name: string, fallback: string) =>
        name === 'gos_hodlr_spread_pct' ? '0' : fallback;
    });

    const withConvar = (value: string, run: () => Promise<void>) => {
      const previous = (globalThis as any).GetConvar;
      (globalThis as any).GetConvar = (name: string, fallback: string) =>
        name === 'gos_hodlr_trade_max' ? value : name === 'gos_hodlr_spread_pct' ? '0' : fallback;
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

    it('refuses a quantity so large it would otherwise reach SQL as a number', async () => {
      /**
       * `requirePositiveInt` was happy with 1e20 and the per-trade value cap caught it a step
       * later, which was the right answer arrived at by luck: `price * quantity` has already
       * overflowed into a float by then, so the cap was comparing a number nobody could hold.
       * `quantity` is an `int(11)` and the contract now says so, which refuses it a step
       * earlier and for the reason that is actually true.
       */
      const reply = await call(SELL, { quantity: 1e20 });

      expect(reply).toMatchObject({ error: expect.stringContaining('quantity') });
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
      const reply = await call('gos:server:hodlr:price', {});

      expect(reply).toEqual({ ready: false, current: 0, history: HISTORY });
    });

    it('withholds the valuation from portfolio but still discloses the holding', async () => {
      const reply = await call('gos:server:hodlr:portfolio', {});

      expect(reply).toEqual({ ready: false, quantity: 5, currentPrice: 0, currentValue: 0 });
    });

    it('keeps serving the chart, which reads storage rather than the unrestored price', async () => {
      const reply = (await call('gos:server:hodlr:price', {})) as { history: unknown[] };

      expect(reply.history).toEqual(HISTORY);
    });
  });

  /**
   * MICA-145. The atomic `quantity = quantity ± ?` update is correct under two concurrent
   * trades on one holding — that's the whole point of it, and it stays exactly as it was.
   * What used to be wrong is the number handed *back* to each caller: it was computed from
   * this handler's own pre-write read (`holding.quantity ± quantity`), which is stale the
   * moment a second trade's write lands in between. Low severity — no money or coins are at
   * risk, nothing is corrupted, it's a display value that could disagree with the database
   * for one round trip until the next portfolio read corrected it. These tests drive two
   * trades that both read the same pre-write snapshot (the interleaving) and assert the
   * echoed quantity is the real post-write total for *both* of them, not either one's own
   * stale local arithmetic.
   */
  describe('echoed quantity under two interleaved trades', () => {
    /**
     * `call()` above reassigns the *global* `emitNet` per invocation, which two genuinely
     * concurrent calls would race on — the second call's assignment can land before the
     * first call's handler ever reaches its own `emitNet(...)`, since that reference is
     * resolved dynamically, not captured at registration. So this drives the raw handler
     * with one shared `emitNet` mock and pulls each reply back out by its own `cbId`.
     */
    const driveConcurrently = (event: string, payloads: [unknown, unknown]) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler for ${event}`);
      (globalThis as any).source = 1;
      const emit = vi.fn();
      (globalThis as any).emitNet = emit;

      const [a, b] = payloads;
      return Promise.all([handler('cb-a', a), handler('cb-b', b)]).then(() => {
        const replyFor = (cbId: string) =>
          emit.mock.calls.find(([, , id]: [unknown, unknown, string]) => id === cbId)?.[3];
        return [replyFor('cb-a'), replyFor('cb-b')];
      });
    };

    /**
     * Gates every `Database.scalar` re-read until every expected write has landed, which is
     * what makes the two trades genuinely interleaved rather than merely sequential: each
     * trade's own pre-write read (`dbMock.query`, stubbed to always return the same stale
     * row) never sees the other's write, but the post-write re-read this fix adds always
     * observes the fully-settled total — the same thing a real concurrent pair of `UPDATE`s
     * against one row would produce.
     */
    const trackWrites = (expected: number, startingQuantity: number) => {
      let stored = startingQuantity;
      let settled = 0;
      let resolveAllWritten: () => void;
      const allWritten = new Promise<void>((resolve) => (resolveAllWritten = resolve));

      dbMock.update.mockImplementation(async (sql: string, params: [number, number]) => {
        const delta = /`quantity` - \?/.test(sql) ? -params[0] : params[0];
        stored += delta;
        settled += 1;
        if (settled === expected) resolveAllWritten();
        return true;
      });
      dbMock.scalar.mockImplementation(async () => {
        await allWritten;
        return stored;
      });

      return () => stored;
    };

    it("reports the real total on both legs of two interleaved buys, not either one's own stale echo", async () => {
      // Both buys' own `findOrCreateHolding` read the same pre-write quantity (5) — the
      // interleaving. Naively, a 3-coin buy would echo 8 and a 4-coin buy would echo 9;
      // the real total once both land is 12.
      dbMock.query.mockResolvedValue([{ ...HOLDING, quantity: 5 }]);
      const finalStored = trackWrites(2, 5);

      const [replyA, replyB] = await driveConcurrently(BUY, [{ quantity: 3 }, { quantity: 4 }]);

      expect(finalStored()).toBe(12);
      expect(replyA).toMatchObject({ ok: true, quantity: 12 });
      expect(replyB).toMatchObject({ ok: true, quantity: 12 });
    });

    it("reports the real total on both legs of two interleaved sells, not either one's own stale echo", async () => {
      // Both sells' own `findOrCreateHolding` read the same pre-write quantity (10). A
      // naive 3-coin sell would echo 7 and a 4-coin sell would echo 6; the real total once
      // both land is 3.
      dbMock.query.mockResolvedValue([{ ...HOLDING, quantity: 10 }]);
      const finalStored = trackWrites(2, 10);

      const [replyA, replyB] = await driveConcurrently(SELL, [{ quantity: 3 }, { quantity: 4 }]);

      expect(finalStored()).toBe(3);
      expect(replyA).toMatchObject({ ok: true, quantity: 3 });
      expect(replyB).toMatchObject({ ok: true, quantity: 3 });
    });
  });
});

/**
 * MICA-147/MICA-149: `quoteSpread` is a pure function of the mid price and the
 * operator's spread percentage, so it is tested directly rather than only through `buy`/
 * `sell` — the boundary/rounding decision `AGENTS.md`'s brief for this ticket asked to be
 * documented and tested is exactly here, not spread across trade-flow assertions that also
 * have money and coins to track.
 */
describe('quoteSpread — the buy/sell spread (MICA-147/149)', () => {
  it('splits the spread evenly above and below mid when both quotes land on whole numbers', () => {
    // 500 at a 2% spread: half-spread is 1%, i.e. +/-5 — no rounding to disambiguate.
    expect(quoteSpread(500, 2)).toEqual({ buy: 505, sell: 495 });
  });

  it('is a real, non-degenerate spread at the lowest price the market ever quotes', () => {
    // HodlrMarket.ts's FLOOR is 50; even there a 2% spread is a full 2-unit gap (51/49),
    // never collapsing to a single price two quotes could round back together into.
    expect(quoteSpread(50, 2)).toEqual({ buy: 51, sell: 49 });
  });

  it('accepts a spread of exactly 0 as a real configuration, not a fallback trigger', () => {
    expect(quoteSpread(500, 0)).toEqual({ buy: 500, sell: 500 });
  });

  /**
   * The rounding boundary the ticket named explicitly: MICA-130 already had to fix a
   * boundary that rounded a downward move back to the value it started from and let a
   * player keep it for free. `Math.round` on a spread quote would occasionally do the same
   * thing in miniature — rounding a fractional cent *toward* the trader on whichever side
   * happened to land past the midpoint of a cent. `Math.ceil`/`Math.floor` never do: every
   * fraction, however small, resolves against the trader.
   */
  describe('rounding always resolves against the trader, never toward them', () => {
    it('rounds a fractional buy quote up, not to nearest', () => {
      // 101 at 1% half-spread: 101 * 1.01 = 102.01. Nearest would still round to 102, so
      // this specifically needs a fraction large enough that `Math.round` and `Math.ceil`
      // would disagree, to prove `ceil` and not `round` is what is actually running.
      expect(quoteSpread(101, 2).buy).toBe(103); // ceil(102.01) = 103, round(102.01) = 102
    });

    it('rounds a fractional sell quote down, not to nearest', () => {
      // 101 at 1% half-spread: 101 * 0.99 = 99.99. `Math.round` would round this up to
      // 100 — a whole unit in the trader's favour — where `floor` gives 99.
      expect(quoteSpread(101, 2).sell).toBe(99); // floor(99.99) = 99, round(99.99) = 100
    });

    it('never lets the sell quote go negative at an extreme, operator-misconfigured spread', () => {
      expect(quoteSpread(50, 500).sell).toBe(0);
    });
  });

  describe('the spread convar (gos_hodlr_spread_pct)', () => {
    const withSpreadConvar = (value: string, run: () => Promise<void> | void) => {
      const previous = (globalThis as any).GetConvar;
      (globalThis as any).GetConvar = (name: string, fallback: string) =>
        name === 'gos_hodlr_spread_pct' ? value : fallback;
      return Promise.resolve(run()).finally(() => {
        (globalThis as any).GetConvar = previous;
      });
    };

    const call = async (event: string, data: unknown) => {
      (globalThis as any).source = 1;
      (globalThis as any).emitNet = vi.fn();
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler for ${event}`);
      await handler('cb-1', data);
      return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
    };

    beforeEach(() => {
      vi.clearAllMocks();
      __resetRateLimits();
      market.price = 10;
      market.ready = true;
      wallet.bank = 1000;
      player.getMoney.mockImplementation(() => wallet.bank);
      player.removeMoney.mockImplementation(() => true);
      player.addMoney.mockImplementation(() => true);
      dbMock.query.mockResolvedValue([
        { id: 7, citizenid: 'CID_CALLER', quantity: 5, status: 'active' }
      ]);
      dbMock.update.mockResolvedValue(1);
    });

    it('widens the settled buy and sell price when an operator sets a wider spread', async () => {
      await withSpreadConvar('50', async () => {
        // mid 10, 50% spread: half-spread 25%, buy = ceil(12.5) = 13, sell = floor(7.5) = 7
        // — chosen to disagree with the 2% default's 11/9, so this actually proves the
        // convar moved the quote rather than merely landing on the same numbers by luck.
        const priceReply = (await call('gos:server:hodlr:price', {})) as {
          buyPrice: number;
          sellPrice: number;
        };
        expect(priceReply.buyPrice).toBe(13);
        expect(priceReply.sellPrice).toBe(7);
      });
    });

    it('falls back to the 2% default when the convar is not a usable number', async () => {
      await withSpreadConvar('not-a-number', async () => {
        const priceReply = (await call('gos:server:hodlr:price', {})) as {
          buyPrice: number;
          sellPrice: number;
        };
        expect(priceReply.buyPrice).toBe(11);
        expect(priceReply.sellPrice).toBe(9);
      });
    });

    it('honours an explicit 0 rather than treating it as unset', async () => {
      await withSpreadConvar('0', async () => {
        const priceReply = (await call('gos:server:hodlr:price', {})) as {
          buyPrice: number;
          sellPrice: number;
        };
        expect(priceReply.buyPrice).toBe(10);
        expect(priceReply.sellPrice).toBe(10);
      });
    });

    it('settles an actual buy at the convar-configured spread, not the default', async () => {
      await withSpreadConvar('40', async () => {
        // mid 10, 40% spread: half-spread 20%, buy = ceil(12) = 12.
        const reply = (await call('gos:server:hodlr:buy', { quantity: 2 })) as {
          ok: boolean;
          price: number;
          cost: number;
        };
        expect(reply).toMatchObject({ ok: true, price: 12, cost: 24 });
      });
    });

    it('settles an actual sell at the convar-configured spread, not the default', async () => {
      await withSpreadConvar('40', async () => {
        // mid 10, 40% spread: half-spread 20%, sell = floor(8) = 8.
        const reply = (await call('gos:server:hodlr:sell', { quantity: 2 })) as {
          ok: boolean;
          price: number;
          proceeds: number;
        };
        expect(reply).toMatchObject({ ok: true, price: 8, proceeds: 16 });
      });
    });
  });
});
