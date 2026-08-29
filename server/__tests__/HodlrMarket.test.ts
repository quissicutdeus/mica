import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  }
}));

vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  getCurrentPrice,
  getPriceHistory,
  isMarketReady,
  __tickMarket,
  __pruneHistory,
  __restorePrice,
  __resetMarketState
} from '../services/HodlrMarket';

const STARTING_PRICE = 500;
const FLOOR = 50;
const CEIL = 5000;
const MAX_STEP_PCT = 0.03;

/**
 * Pins `Math.random` so a tick's direction is exact rather than probable.
 *
 * The step is `(Math.random() * 2 - 1) * 0.03` applied in log space, so 1 is the largest
 * up-tick this market can take and 0 the largest down-tick. Anything in between is a
 * smaller move of the corresponding sign; 0.5 is a no-op at the reference price.
 */
const alwaysStep = (value: number) => vi.spyOn(Math, 'random').mockReturnValue(value);
const MAX_UP = 1;
const MAX_DOWN = 0;
const NO_MOVE = 0.5;

/** A fixed sequence of draws, so a many-tick property is deterministic rather than flaky. */
const stepSequence = (values: number[]) => {
  let i = 0;
  return vi.spyOn(Math, 'random').mockImplementation(() => values[i++ % values.length]);
};

/**
 * A seeded generator standing in for `Math.random`, for the statistical properties below. A
 * real `Math.random` would make them probabilistic and therefore flaky; the same seed makes
 * the whole walk reproducible while still exercising a full spread of draws.
 */
const seededRandom = (seed: number) => {
  let state = seed % 2147483647;
  return vi.spyOn(Math, 'random').mockImplementation(() => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  });
};

/** Every price this suite's snapshot inserts have recorded, oldest first. */
const snapshottedPrices = (): number[] =>
  dbMock.insert.mock.calls.map((call) => (call[1] as number[])[0]);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  __resetMarketState();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(1);
  dbMock.scalar.mockResolvedValue(null);
});

describe('HodlrMarket price', () => {
  it('starts at the opening price', () => {
    expect(getCurrentPrice()).toBe(STARTING_PRICE);
  });

  it('moves the price by no more than 3% in a single tick', () => {
    alwaysStep(MAX_UP);
    __tickMarket();

    expect(getCurrentPrice()).toBeGreaterThan(STARTING_PRICE);
    expect(getCurrentPrice()).toBeLessThanOrEqual(Math.round(STARTING_PRICE * (1 + MAX_STEP_PCT)));
  });

  it('records a snapshot of the new price whenever the price moves', () => {
    alwaysStep(MAX_UP);
    __tickMarket();

    expect(snapshottedPrices()).toEqual([getCurrentPrice()]);
  });

  it('records nothing when a tick rounds back to the price it started from', () => {
    // The guard that matters: without the `next === currentPrice` early return, a market
    // sitting still would still write a history row every 30 seconds forever.
    alwaysStep(NO_MOVE);
    __tickMarket();

    expect(getCurrentPrice()).toBe(STARTING_PRICE);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('never falls below the floor, however long the market slides', () => {
    alwaysStep(MAX_DOWN);
    for (let i = 0; i < 200; i++) __tickMarket();

    expect(getCurrentPrice()).toBeGreaterThanOrEqual(FLOOR);
    expect(Math.min(...snapshottedPrices())).toBeGreaterThanOrEqual(FLOOR);
  });

  it('never rises above the ceiling, however long the market climbs', () => {
    alwaysStep(MAX_UP);
    for (let i = 0; i < 200; i++) __tickMarket();

    expect(getCurrentPrice()).toBeLessThanOrEqual(CEIL);
    expect(Math.max(...snapshottedPrices())).toBeLessThanOrEqual(CEIL);
  });

  it('keeps the price it already moved to when the snapshot write fails', () => {
    // The snapshot is for the chart; the price is what trades settle against. A database
    // that is down must not be able to roll the market back or throw into the tick timer.
    dbMock.insert.mockRejectedValue(new Error('db down'));
    alwaysStep(MAX_UP);

    expect(() => __tickMarket()).not.toThrow();
    expect(getCurrentPrice()).toBeGreaterThan(STARTING_PRICE);
  });
});

/**
 * MICA-130, part 2: the walk used to decay by construction.
 *
 * The step was `price * (1 + U)` for a symmetric `U`, and `E[log(1 + U)] < 0` — so however
 * fair a single step looked, the typical path drifted down and the coin sat below its
 * opening price most of the time. "Wait for it to dip under 500" was the market's default
 * state rather than an occasional window, which is what made the restart exploit reliable.
 */
describe('HodlrMarket drift', () => {
  it('returns to where it started after equal and opposite steps', () => {
    // The discriminator: under the old multiplicative rule a +3%/-3% pair lost 0.09% of the
    // price every time, so 300 of them ratcheted a market that never moved down by 24%.
    stepSequence([MAX_UP, MAX_DOWN]);
    for (let i = 0; i < 600; i++) __tickMarket();

    expect(getCurrentPrice()).toBe(STARTING_PRICE);
  });

  it('keeps a day of trading centred on the reference price rather than sliding under it', () => {
    seededRandom(20260130);
    const ticks = 2880; // a day of 30-second ticks
    const path: number[] = [];

    for (let i = 0; i < ticks; i++) {
      __tickMarket();
      path.push(getCurrentPrice());
    }

    // The median of the path, not the last price: a single endpoint is noise, and the
    // decay the audit measured was in where the price *lived*. This same seeded walk under
    // the old multiplicative step has a median of 265 — the whole day spent 47% under the
    // open, which is what made "wait for it to dip below 500" a certainty rather than a bet.
    const median = [...path].sort((a, b) => a - b)[Math.floor(path.length / 2)];

    expect(median).toBeGreaterThan(STARTING_PRICE * 0.8);
    expect(median).toBeLessThan(STARTING_PRICE * 1.2);
  });

  it('is still inside a tradeable band after a week of uptime', () => {
    // Mean reversion is what keeps a long-running server off the boundaries. Without it a
    // driftless walk of this volatility reaches a clamp within days and stays there, which
    // is a dead market in one direction and a free option in the other.
    seededRandom(987654321);
    for (let i = 0; i < 20160; i++) __tickMarket();

    expect(getCurrentPrice()).toBeGreaterThan(FLOOR * 2);
    expect(getCurrentPrice()).toBeLessThan(CEIL / 2);
  });
});

/**
 * MICA-130, part 3: the floor was a free option.
 *
 * At 50 a down-step rounded back to 50 and `next === currentPrice` made it a no-op, so a
 * holder sitting on the floor had zero downside and strictly positive expectation — buy at
 * 50, sell at 52, repeat, no restart required. The boundary now reflects instead of
 * flattening, so a step is turned around rather than swallowed, in both directions.
 */
describe('HodlrMarket boundaries', () => {
  it('turns a down-step at the floor into a real move rather than swallowing it', () => {
    __resetMarketState({ price: FLOOR });
    alwaysStep(MAX_DOWN);

    __tickMarket();

    expect(getCurrentPrice()).not.toBe(FLOOR);
    expect(getCurrentPrice()).toBeGreaterThanOrEqual(FLOOR);
    expect(snapshottedPrices()).toEqual([getCurrentPrice()]);
  });

  it('bounds the ceiling the same way it bounds the floor', () => {
    __resetMarketState({ price: CEIL });
    alwaysStep(MAX_UP);

    __tickMarket();

    expect(getCurrentPrice()).not.toBe(CEIL);
    expect(getCurrentPrice()).toBeLessThanOrEqual(CEIL);
    expect(snapshottedPrices()).toEqual([getCurrentPrice()]);
  });

  it('keeps a market pinned at the floor inside the band', () => {
    __resetMarketState({ price: FLOOR });
    alwaysStep(MAX_DOWN);
    for (let i = 0; i < 200; i++) __tickMarket();

    expect(Math.min(...snapshottedPrices())).toBeGreaterThanOrEqual(FLOOR);
    expect(Math.max(...snapshottedPrices())).toBeLessThanOrEqual(CEIL);
  });
});

/**
 * MICA-130, part 1: the price is state that survives a restart.
 *
 * `gphone_hodlr.quantity` always did. The price did not, so every restart re-valued every
 * holding at the 500 written in the source — buy below it, wait for a restart, sell.
 */
describe('HodlrMarket restore', () => {
  it('reopens at the price the last snapshot recorded', async () => {
    __resetMarketState({ restored: false });
    dbMock.scalar.mockResolvedValue(172);

    await __restorePrice();

    expect(getCurrentPrice()).toBe(172);
    expect(isMarketReady()).toBe(true);
  });

  it('reads the newest row by id rather than by a timestamp that can tie', async () => {
    __resetMarketState({ restored: false });

    await __restorePrice();

    const [sql] = dbMock.scalar.mock.calls[0];
    expect(sql).toMatch(/ORDER BY .*`id`.*DESC/s);
    expect(sql).toMatch(/LIMIT 1/);
  });

  it('opens a fresh install at the opening price when there is no history at all', async () => {
    __resetMarketState({ restored: false });
    dbMock.scalar.mockResolvedValue(null);

    await __restorePrice();

    expect(getCurrentPrice()).toBe(STARTING_PRICE);
    expect(isMarketReady()).toBe(true);
  });

  it('clamps a stored price that is outside the band rather than trusting it', async () => {
    __resetMarketState({ restored: false });
    dbMock.scalar.mockResolvedValue(999999);

    await __restorePrice();

    expect(getCurrentPrice()).toBe(CEIL);
  });

  it('ignores a stored value that is not a price', async () => {
    __resetMarketState({ restored: false });
    dbMock.scalar.mockResolvedValue('not a number');

    await __restorePrice();

    expect(getCurrentPrice()).toBe(STARTING_PRICE);
  });

  it('leaves the market closed when the read fails, rather than opening it at 500', async () => {
    __resetMarketState({ restored: false });
    dbMock.scalar.mockRejectedValue(new Error('db down'));

    await expect(__restorePrice()).resolves.toBeUndefined();

    expect(isMarketReady()).toBe(false);
  });

  it('retries the restore on the next tick instead of trading off the opening price', async () => {
    __resetMarketState({ restored: false });
    dbMock.scalar.mockRejectedValue(new Error('db down'));
    await __restorePrice();

    // A tick before the restore lands must not move the price — the move would be recorded,
    // and that snapshot would then be the newest row, overwriting the price being restored.
    alwaysStep(MAX_UP);
    dbMock.scalar.mockResolvedValue(200);
    __tickMarket();
    await Promise.resolve();

    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(getCurrentPrice()).toBe(200);
    expect(isMarketReady()).toBe(true);
  });

  it('does not read twice for one restore', async () => {
    __resetMarketState({ restored: false });
    dbMock.scalar.mockResolvedValue(300);

    await __restorePrice();
    await __restorePrice();

    expect(dbMock.scalar).toHaveBeenCalledTimes(1);
  });
});

describe('HodlrMarket history', () => {
  it('reads the chart window oldest first', async () => {
    const rows = [{ price: 500, recorded_at: '2026-08-20T00:00:00Z' }];
    dbMock.query.mockResolvedValue(rows);

    expect(await getPriceHistory()).toEqual(rows);

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY .*ASC/s);
    expect(params).toEqual([24]);
  });

  it('returns an empty history rather than throwing when the read fails', async () => {
    dbMock.query.mockRejectedValue(new Error('db down'));

    expect(await getPriceHistory()).toEqual([]);
  });

  it('prunes snapshots older than the retention window', async () => {
    await __pruneHistory();

    const [sql, params] = dbMock.update.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM/);
    expect(params).toEqual([7]);
  });

  it('swallows a failed prune rather than throwing into the sweep timer', async () => {
    dbMock.update.mockRejectedValue(new Error('db down'));

    await expect(__pruneHistory()).resolves.toBeUndefined();
  });
});
