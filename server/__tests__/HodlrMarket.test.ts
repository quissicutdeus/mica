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
  __tickMarket,
  __pruneHistory,
  __resetMarketState
} from '../services/HodlrMarket';

const STARTING_PRICE = 500;
const FLOOR = 50;
const CEIL = 5000;

/**
 * Pins `Math.random` so a tick's direction is exact rather than probable.
 *
 * The step is `(Math.random() * 2 - 1) * 0.03`, so 1 is the largest up-tick this market
 * can take and 0 the largest down-tick. Anything in between is a smaller move of the
 * corresponding sign; 0.5 is a no-op.
 */
const alwaysStep = (value: number) => vi.spyOn(Math, 'random').mockReturnValue(value);
const MAX_UP = 1;
const MAX_DOWN = 0;
const NO_MOVE = 0.5;

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
});

describe('HodlrMarket price', () => {
  it('starts at the opening price', () => {
    expect(getCurrentPrice()).toBe(STARTING_PRICE);
  });

  it('moves the price by no more than 3% in a single tick', () => {
    alwaysStep(MAX_UP);
    __tickMarket();

    expect(getCurrentPrice()).toBe(Math.round(STARTING_PRICE * 1.03));
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

    expect(getCurrentPrice()).toBe(FLOOR);
    expect(Math.min(...snapshottedPrices())).toBe(FLOOR);
  });

  it('never rises above the ceiling, however long the market climbs', () => {
    alwaysStep(MAX_UP);
    for (let i = 0; i < 200; i++) __tickMarket();

    expect(getCurrentPrice()).toBe(CEIL);
    expect(Math.max(...snapshottedPrices())).toBe(CEIL);
  });

  it('keeps the price it already moved to when the snapshot write fails', () => {
    // The snapshot is for the chart; the price is what trades settle against. A database
    // that is down must not be able to roll the market back or throw into the tick timer.
    dbMock.insert.mockRejectedValue(new Error('db down'));
    alwaysStep(MAX_UP);

    expect(() => __tickMarket()).not.toThrow();
    expect(getCurrentPrice()).toBe(Math.round(STARTING_PRICE * 1.03));
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
