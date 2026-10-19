// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DbCall } from './dbMockTypes';

/**
 * Casino (MICA-82): roulette and Crash, money through the framework, every outcome decided on
 * the server. The database is a small in-memory world that answers the service's own SQL, so a
 * conditional settle really is conditional here and a race can be staged between two of them.
 */

type Row = {
  id: number;
  citizenid: string;
  game: 'roulette' | 'crash';
  status: 'active' | 'settled' | 'deleted';
  stake: number;
  payout: number;
  multiplier: number | null;
  crash_point: number | null;
  result: string | null;
  created_at: string;
};

const { dbMock, handlers, pushes, world } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: {
      query: vi.fn<DbCall<unknown>>(),
      insert: vi.fn<DbCall<number>>(),
      update: vi.fn<DbCall<boolean>>(),
      scalar: vi.fn(),
      single: vi.fn()
    },
    handlers: captured,
    pushes: [] as { to: string; event: string; payload: any }[],
    world: {
      rows: [] as Row[],
      nextId: 0,
      /** Runs inside the next own-round read: what a racing settle did meanwhile. */
      duringRead: undefined as (() => void) | undefined,
      insertFails: undefined as Error | undefined,
      /** The next insert commits its row and then rejects, as a timed-out insert can. */
      insertCommitsThenFails: false,
      /** Runs inside the next insert, after its row is in. */
      duringInsert: undefined as (() => void) | undefined
    }
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const wallet = vi.hoisted(() => ({ bank: 0, citizenid: 'CID_A' }));
const money = vi.hoisted(() => ({
  getMoney: vi.fn(),
  removeMoney: vi.fn(),
  addMoney: vi.fn()
}));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) =>
      src === 1
        ? {
            citizenid: wallet.citizenid,
            source: 1,
            getMoney: money.getMoney,
            removeMoney: money.removeMoney,
            addMoney: money.addMoney
          }
        : null,
    getCitizenId: () => wallet.citizenid,
    registerUsableItem: () => {}
  }
}));

vi.mock('../lib/appEvents', () => ({
  appEventChannel: (appId: string) => ({
    appId,
    push: (to: string, event: string, payload: any) => {
      pushes.push({ to, event, payload });
      return { delivered: true };
    },
    pushMany: () => ({ delivered: [], offline: [] })
  })
}));

import {
  CRASH_POINT_MAX,
  HISTORY_PAGING,
  INSTANT_BUST,
  __isLiveForTests,
  __resetCasinoForTests,
  __setCrashDrawForTests,
  __setWheelForTests,
  betIsWellFormed,
  betReturn,
  colorOf,
  crashDelayMs,
  crashPointFor,
  multiplierAt,
  onCasinoResourceStart,
  secureInt,
  spinPayout,
  STALE_SWEEP_MS,
  sweepStaleCrashRounds
} from '../services/Casino';
import { __resetRateLimits } from '../lib/rateLimit';
import { __setSchemaReadyForTests } from '../lib/schemaReady';
import { exportFilterFor } from '../services/Privacy';
import { NOT_HELD_REPLY, installTestPhone, refusePhone } from './phoneStub';
import type { CasinoBet } from '@mica/shared/types';

// ---------------------------------------------------------------------------------------------
// The world: answers exactly the statements Casino.ts sends, and fails loudly on any other.
// ---------------------------------------------------------------------------------------------

const one = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const liveCrashOf = (citizenid: unknown) =>
  world.rows.find((r) => r.citizenid === citizenid && r.game === 'crash' && r.status === 'active');

const answerQuery = async (sql: string, params: unknown[] = []): Promise<unknown> => {
  const q = one(sql);
  if (q.startsWith('SELECT `id` FROM `mica_casino_rounds` WHERE `active_crash` = ?')) {
    const row = liveCrashOf(params[0]);
    return row ? [{ id: row.id }] : [];
  }
  if (q.startsWith('SELECT `id`, `stake` FROM `mica_casino_rounds` WHERE `active_crash` = ?')) {
    const row = liveCrashOf(params[0]);
    return row ? [{ id: row.id, stake: row.stake }] : [];
  }
  if (q.startsWith('SELECT `id`, `citizenid`, `crash_point`, `result`')) {
    const oneCitizen = q.endsWith('WHERE `active_crash` = ?');
    expect(oneCitizen || q.endsWith('WHERE `active_crash` IS NOT NULL')).toBe(true);
    return world.rows
      .filter((r) => r.game === 'crash' && r.status === 'active')
      .filter((r) => !oneCitizen || r.citizenid === params[0])
      .map(({ id, citizenid, crash_point, result }) => ({ id, citizenid, crash_point, result }));
  }
  if (q.startsWith('SELECT `id`, `stake`, `payout`, `multiplier`, `status`, `crash_point`')) {
    const hook = world.duringRead;
    world.duringRead = undefined;
    hook?.();
    const [roundId, citizenid] = params;
    return world.rows
      .filter(
        (r) =>
          r.id === roundId &&
          r.citizenid === citizenid &&
          r.game === 'crash' &&
          r.status !== 'deleted'
      )
      .map(({ id, stake, payout, multiplier, status, crash_point }) => ({
        id,
        stake,
        payout,
        multiplier,
        status,
        crash_point
      }));
  }
  if (q.includes('ORDER BY `id` DESC LIMIT ?')) {
    const citizenid = params[0];
    const cursor = params.length === 3 ? (params[1] as number) : null;
    const limit = params[params.length - 1] as number;
    return world.rows
      .filter((r) => r.citizenid === citizenid && r.status !== 'deleted')
      .filter((r) => cursor === null || r.id < cursor)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(({ citizenid: _c, ...rest }) => ({ ...rest }));
  }
  throw new Error(`unexpected query: ${q}`);
};

const answerInsert = async (sql: string, params: unknown[] = []): Promise<number> => {
  const q = one(sql);
  if (!q.startsWith('INSERT INTO `mica_casino_rounds`')) throw new Error(`unexpected insert: ${q}`);
  if (world.insertFails) {
    const error = world.insertFails;
    world.insertFails = undefined;
    throw error;
  }
  const [citizenid, game, status, stake, payout, multiplier, crash_point, result] = params as [
    string,
    Row['game'],
    Row['status'],
    number,
    number,
    number | null,
    number | null,
    string
  ];
  if (game === 'crash' && status === 'active' && liveCrashOf(citizenid)) {
    throw new Error(`Duplicate entry '${citizenid}' for key 'active_crash'`);
  }
  world.nextId += 1;
  world.rows.push({
    id: world.nextId,
    citizenid,
    game,
    status,
    stake,
    payout,
    multiplier,
    crash_point,
    result,
    created_at: '2026-10-18 12:00:00'
  });
  const hook = world.duringInsert;
  world.duringInsert = undefined;
  hook?.();
  if (world.insertCommitsThenFails) {
    world.insertCommitsThenFails = false;
    throw new Error('oxmysql: query timed out');
  }
  return world.nextId;
};

const answerUpdate = async (sql: string, params: unknown[] = []): Promise<boolean> => {
  const q = one(sql);
  if (
    q ===
    "UPDATE `mica_casino_rounds` SET `status` = 'settled', `payout` = 0 WHERE `id` = ? AND `status` = 'active'"
  ) {
    const row = world.rows.find((r) => r.id === params[0] && r.status === 'active');
    if (!row) return false;
    row.status = 'settled';
    row.payout = 0;
    return true;
  }
  if (q.startsWith("UPDATE `mica_casino_rounds` SET `status` = 'settled', `multiplier` = ?")) {
    expect(q).toContain("WHERE `id` = ? AND `citizenid` = ? AND `status` = 'active'");
    expect(q).toContain('AND `crash_point` >= ?');
    const [multiplier, payout, id, citizenid, floor] = params as number[];
    const row = world.rows.find(
      (r) =>
        r.id === id &&
        r.citizenid === (citizenid as unknown) &&
        r.status === 'active' &&
        (r.crash_point ?? 0) >= floor
    );
    if (!row) return false;
    row.status = 'settled';
    row.multiplier = multiplier;
    row.payout = payout;
    return true;
  }
  if (q.startsWith('UPDATE `mica_casino_rounds` SET `multiplier` = ?, `payout` = ? WHERE')) {
    expect(q).toContain(
      "`status` = 'settled' AND `payout` = 0 AND `multiplier` IS NULL AND `crash_point` >= ?"
    );
    const [multiplier, payout, id, citizenid, floor] = params as number[];
    const row = world.rows.find(
      (r) =>
        r.id === id &&
        r.citizenid === (citizenid as unknown) &&
        r.status === 'settled' &&
        r.payout === 0 &&
        r.multiplier === null &&
        (r.crash_point ?? 0) >= floor
    );
    if (!row) return false;
    row.multiplier = multiplier;
    row.payout = payout;
    return true;
  }
  throw new Error(`unexpected update: ${q}`);
};

// ---------------------------------------------------------------------------------------------
// Calling the handlers
// ---------------------------------------------------------------------------------------------

const call = async (action: string, data: unknown): Promise<any> => {
  (globalThis as any).source = 1;
  const emit = vi.fn();
  (globalThis as any).emitNet = emit;
  const handler = handlers.get(`mica:server:casino:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  await handler('cb-1', data);
  return emit.mock.calls.at(-1)?.[3];
};

const convars: Record<string, string> = {};
const realGetConvar = (globalThis as any).GetConvar;

/** Crash draw `u` that lands exactly on the point `cp` (×100) at the default 3% edge. */
const drawFor = (cp: number) => 97 / (cp + 0.5);

const debits = () => money.removeMoney.mock.calls.map(([, n]) => n);
const credits = () => money.addMoney.mock.calls.map(([, n]) => n);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    now: Date.now() + 60_000,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  });
  __resetRateLimits();
  __resetCasinoForTests();
  __setWheelForTests();
  __setCrashDrawForTests();
  installTestPhone();
  world.rows = [];
  world.nextId = 0;
  world.duringRead = undefined;
  world.insertFails = undefined;
  world.insertCommitsThenFails = false;
  world.duringInsert = undefined;
  pushes.length = 0;
  for (const key of Object.keys(convars)) delete convars[key];
  (globalThis as any).GetConvar = (name: string, fallback: string) => convars[name] ?? fallback;
  wallet.bank = 100_000;
  wallet.citizenid = 'CID_A';
  money.getMoney.mockImplementation(() => wallet.bank);
  money.removeMoney.mockImplementation((_a: string, n: number) => {
    wallet.bank -= n;
    return true;
  });
  money.addMoney.mockImplementation((_a: string, n: number) => {
    wallet.bank += n;
    return true;
  });
  dbMock.query.mockImplementation(answerQuery);
  dbMock.insert.mockImplementation(answerInsert);
  dbMock.update.mockImplementation(answerUpdate);
});

afterEach(() => {
  __resetCasinoForTests();
  vi.useRealTimers();
  (globalThis as any).GetConvar = realGetConvar;
});

// ---------------------------------------------------------------------------------------------
// Roulette
// ---------------------------------------------------------------------------------------------

describe('roulette: the payout table', () => {
  const bet = (kind: CasinoBet['kind'], value?: number): CasinoBet =>
    value === undefined ? { kind, amount: 10 } : { kind, value, amount: 10 };

  it('colors the wheel with the standard red set and a green zero', () => {
    const reds = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
    for (let n = 0; n <= 36; n++) {
      expect(colorOf(n), String(n)).toBe(n === 0 ? 'green' : reds.includes(n) ? 'red' : 'black');
    }
  });

  it('pays a straight 35:1 on its number only, zero included', () => {
    expect(betReturn(bet('straight', 17), 17)).toBe(360);
    expect(betReturn(bet('straight', 17), 18)).toBe(0);
    expect(betReturn(bet('straight', 0), 0)).toBe(360);
    expect(betReturn(bet('straight', 0), 1)).toBe(0);
  });

  it('pays a dozen and a column 2:1', () => {
    expect(betReturn(bet('dozen', 1), 1)).toBe(30);
    expect(betReturn(bet('dozen', 1), 12)).toBe(30);
    expect(betReturn(bet('dozen', 1), 13)).toBe(0);
    expect(betReturn(bet('dozen', 2), 24)).toBe(30);
    expect(betReturn(bet('dozen', 3), 25)).toBe(30);
    expect(betReturn(bet('dozen', 3), 36)).toBe(30);
    expect(betReturn(bet('column', 1), 34)).toBe(30);
    expect(betReturn(bet('column', 2), 35)).toBe(30);
    expect(betReturn(bet('column', 3), 36)).toBe(30);
    expect(betReturn(bet('column', 3), 35)).toBe(0);
  });

  it('pays every even-money bet 1:1', () => {
    expect(betReturn(bet('red'), 1)).toBe(20);
    expect(betReturn(bet('red'), 2)).toBe(0);
    expect(betReturn(bet('black'), 2)).toBe(20);
    expect(betReturn(bet('black'), 1)).toBe(0);
    expect(betReturn(bet('odd'), 35)).toBe(20);
    expect(betReturn(bet('odd'), 36)).toBe(0);
    expect(betReturn(bet('even'), 36)).toBe(20);
    expect(betReturn(bet('even'), 35)).toBe(0);
    expect(betReturn(bet('low'), 18)).toBe(20);
    expect(betReturn(bet('low'), 19)).toBe(0);
    expect(betReturn(bet('high'), 19)).toBe(20);
    expect(betReturn(bet('high'), 18)).toBe(0);
  });

  it('loses every outside bet on zero', () => {
    const outside: CasinoBet[] = [
      bet('red'),
      bet('black'),
      bet('odd'),
      bet('even'),
      bet('low'),
      bet('high'),
      bet('dozen', 1),
      bet('dozen', 2),
      bet('dozen', 3),
      bet('column', 1),
      bet('column', 2),
      bet('column', 3)
    ];
    for (const b of outside) expect(betReturn(b, 0), `${b.kind} ${b.value ?? ''}`).toBe(0);
  });

  it('holds the single-zero edge: every bet kind returns 36/37 over the whole wheel', () => {
    const everyKind: CasinoBet[] = [
      bet('straight', 7),
      bet('straight', 0),
      bet('red'),
      bet('black'),
      bet('odd'),
      bet('even'),
      bet('low'),
      bet('high'),
      bet('dozen', 2),
      bet('column', 1)
    ];
    for (const b of everyKind) {
      let returned = 0;
      for (let n = 0; n <= 36; n++) returned += betReturn(b, n);
      expect(returned / (37 * 10), b.kind).toBeCloseTo(36 / 37, 10);
    }
  });

  it('sums a multi-bet spin', () => {
    expect(spinPayout([bet('straight', 3), bet('red'), bet('even')], 3)).toBe(360 + 20);
  });

  it('wants a value exactly where the kind needs one, in its range', () => {
    expect(betIsWellFormed({ kind: 'straight', amount: 10 })).toBe(false);
    expect(betIsWellFormed({ kind: 'straight', value: 0, amount: 10 })).toBe(true);
    expect(betIsWellFormed({ kind: 'straight', value: 36, amount: 10 })).toBe(true);
    expect(betIsWellFormed({ kind: 'dozen', value: 0, amount: 10 })).toBe(false);
    expect(betIsWellFormed({ kind: 'dozen', value: 4, amount: 10 })).toBe(false);
    expect(betIsWellFormed({ kind: 'column', value: 3, amount: 10 })).toBe(true);
    expect(betIsWellFormed({ kind: 'column', amount: 10 })).toBe(false);
    expect(betIsWellFormed({ kind: 'red', value: 1, amount: 10 })).toBe(false);
    expect(betIsWellFormed({ kind: 'high', amount: 10 })).toBe(true);
  });

  it('draws the wheel without modulo bias, rejecting the draws above the last multiple', () => {
    const draws = [2 ** 48 - 1, 2 ** 48 - 2, 40];
    expect(secureInt(37, () => draws.shift()!)).toBe(40 % 37);
    expect(draws).toEqual([]);
  });
});

describe('roulette: spin', () => {
  it('debits the total once, credits the payout once, and records the round', async () => {
    __setWheelForTests(() => 17);
    const bets = [
      { kind: 'straight', value: 17, amount: 10 },
      { kind: 'black', amount: 20 },
      { kind: 'even', amount: 30 }
    ];

    const reply = await call('spin', { bets });

    expect(reply).toEqual({ round_id: 1, number: 17, color: 'black', stake: 60, payout: 360 + 40 });
    expect(debits()).toEqual([60]);
    expect(credits()).toEqual([400]);
    expect(wallet.bank).toBe(100_000 - 60 + 400);
    expect(world.rows).toEqual([
      expect.objectContaining({
        id: 1,
        citizenid: 'CID_A',
        game: 'roulette',
        status: 'settled',
        stake: 60,
        payout: 400,
        crash_point: null
      })
    ]);
    expect(JSON.parse(world.rows[0].result!)).toEqual({ number: 17, bets });
  });

  it('credits nothing on a losing spin, and zero takes the outside bets', async () => {
    __setWheelForTests(() => 0);
    const reply = await call('spin', {
      bets: [
        { kind: 'red', amount: 50 },
        { kind: 'dozen', value: 1, amount: 50 }
      ]
    });
    expect(reply).toMatchObject({ number: 0, color: 'green', stake: 100, payout: 0 });
    expect(debits()).toEqual([100]);
    expect(money.addMoney).not.toHaveBeenCalled();
  });

  it('checks the balance and debits in that order, before the wheel is drawn', async () => {
    const order: string[] = [];
    money.getMoney.mockImplementation(() => (order.push('balance'), wallet.bank));
    money.removeMoney.mockImplementation(() => (order.push('debit'), true));
    __setWheelForTests(() => (order.push('wheel'), 5));
    await call('spin', { bets: [{ kind: 'odd', amount: 10 }] });
    expect(order).toEqual(['balance', 'debit', 'wheel']);
  });

  it.each([
    ['below the table minimum', [{ kind: 'red', amount: 9 }], 'below_min'],
    [
      'a total over the table maximum',
      [
        { kind: 'red', amount: 3000 },
        { kind: 'black', amount: 2001 }
      ],
      'above_max'
    ],
    ['a straight with no number', [{ kind: 'straight', amount: 10 }], 'invalid_bet'],
    ['an outside bet with a value', [{ kind: 'red', value: 3, amount: 10 }], 'invalid_bet'],
    ['a dozen out of range', [{ kind: 'dozen', value: 0, amount: 10 }], 'invalid_bet'],
    ['a column out of range', [{ kind: 'column', value: 4, amount: 10 }], 'invalid_bet']
  ])('refuses %s and moves no money', async (_what, bets, reason) => {
    expect(await call('spin', { bets })).toEqual({ ok: false, reason });
    expect(money.getMoney).not.toHaveBeenCalled();
    expect(money.removeMoney).not.toHaveBeenCalled();
    expect(world.rows).toEqual([]);
  });

  it('accepts exactly the maximum total, with every bet at the minimum or more', async () => {
    const reply = await call('spin', {
      bets: [
        { kind: 'red', amount: 4990 },
        { kind: 'black', amount: 10 }
      ]
    });
    expect(reply).toMatchObject({ stake: 5000 });
  });

  it.each([
    ['no bets', { bets: [] }],
    ['twenty-one bets', { bets: Array.from({ length: 21 }, () => ({ kind: 'red', amount: 10 })) }],
    ['an unknown kind', { bets: [{ kind: 'split', amount: 10 }] }],
    ['a fractional amount', { bets: [{ kind: 'red', amount: 10.5 }] }],
    ['an extra key', { bets: [{ kind: 'red', amount: 10, payout: 9999 }] }]
  ])('refuses %s at the contract', async (_what, data) => {
    const reply = await call('spin', data);
    expect(reply).toHaveProperty('error');
    expect(money.removeMoney).not.toHaveBeenCalled();
  });

  it('reads the table limits from the convars on every call', async () => {
    convars.mica_casino_bet_min = '100';
    convars.mica_casino_bet_max = '150';
    expect(await call('spin', { bets: [{ kind: 'red', amount: 99 }] })).toEqual({
      ok: false,
      reason: 'below_min'
    });
    expect(
      await call('spin', {
        bets: [
          { kind: 'red', amount: 100 },
          { kind: 'odd', amount: 100 }
        ]
      })
    ).toEqual({ ok: false, reason: 'above_max' });
  });

  it('refuses a balance short of the total, and a debit the framework refuses', async () => {
    wallet.bank = 59;
    const bets = [{ kind: 'red', amount: 60 }];
    expect(await call('spin', { bets })).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(money.removeMoney).not.toHaveBeenCalled();

    money.getMoney.mockReturnValue(Number.NEGATIVE_INFINITY);
    expect(await call('spin', { bets })).toEqual({ ok: false, reason: 'insufficient_funds' });

    money.getMoney.mockReturnValue(1000);
    money.removeMoney.mockReturnValue(false);
    expect(await call('spin', { bets })).toEqual({ ok: false, reason: 'debit_failed' });
    expect(world.rows).toEqual([]);
    expect(money.addMoney).not.toHaveBeenCalled();
  });

  it('refunds the whole stake and pays nothing when the round cannot be recorded', async () => {
    __setWheelForTests(() => 17);
    world.insertFails = new Error('Lost connection to MySQL server');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = await call('spin', { bets: [{ kind: 'straight', value: 17, amount: 100 }] });
    expect(reply).toEqual({ ok: false, reason: 'round_failed' });
    expect(debits()).toEqual([100]);
    expect(credits()).toEqual([100]);
    expect(wallet.bank).toBe(100_000);
    error.mockRestore();
  });

  it('logs loudly when the payout credit fails', async () => {
    __setWheelForTests(() => 1);
    money.addMoney.mockReturnValue(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = await call('spin', { bets: [{ kind: 'red', amount: 10 }] });
    expect(reply).toMatchObject({ payout: 20 });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not credit 20 to CID_A/));
    error.mockRestore();
  });

  it('refuses a spin from a player holding no phone (MICA-339)', async () => {
    refusePhone();
    expect(await call('spin', { bets: [{ kind: 'red', amount: 10 }] })).toEqual(NOT_HELD_REPLY);
    expect(money.removeMoney).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Crash: the math
// ---------------------------------------------------------------------------------------------

describe('crash: the math', () => {
  /** A stratified grid over (0, 1]: the exact distribution, sampled evenly. */
  const grid = (n: number) => Array.from({ length: n }, (_, i) => (i + 1) / n);

  const draw = (edge: number) => grid(200_000).map((u) => crashPointFor(u, edge));

  it.each([0, 3, 10, 20])('busts instantly with probability e at a %d%% edge', (edge) => {
    const points = draw(edge);
    const instant = points.filter((p) => p === INSTANT_BUST).length / points.length;
    expect(instant).toBeCloseTo(edge / 100, 4);
  });

  it.each([0, 3, 10, 20])(
    'wins a cash-out at x with probability (1 − e)/x at a %d%% edge',
    (edge) => {
      const points = draw(edge);
      // A tie goes to the player, so a cash-out at x wins exactly when the point is at least x.
      const wins = (x: number) =>
        points.filter((p) => p !== INSTANT_BUST && p >= x).length / points.length;
      for (const x of [100, 101, 150, 200, 1_000, 10_000]) {
        expect(wins(x), `x=${x}`).toBeCloseTo(((1 - edge / 100) * 100) / x, 3);
      }
    }
  );

  it('returns exactly 1 − e of the stake on average at every cash-out target', () => {
    const points = draw(3);
    // Up to 20×: past that, one boundary sample of the grid moves the mean by a visible amount.
    for (const target of [100, 101, 150, 200, 500, 2_000]) {
      const returned = points.reduce<number>(
        (sum, p) => sum + (p !== INSTANT_BUST && p >= target ? target / 100 : 0),
        0
      );
      expect(returned / points.length, `target ${target}`).toBeCloseTo(0.97, 3);
    }
  });

  it('caps the point at 1000.00, and below a raw 1.00 the round busts before it starts', () => {
    expect(crashPointFor(1e-12, 3)).toBe(CRASH_POINT_MAX);
    expect(crashPointFor(1, 3)).toBe(INSTANT_BUST);
    expect(crashPointFor(0.97, 3)).toBe(100);
    expect(crashPointFor(1, 0)).toBe(100);
    expect(crashPointFor(0.5, 0)).toBe(200);
    expect(draw(0)).not.toContain(INSTANT_BUST);
  });

  it('reads the edge convar, clamped to 0..20, defaulting to 3', async () => {
    expect(await call('config', {})).toEqual({
      bet_min: 10,
      bet_max: 5000,
      crash_edge_pct: 3,
      wheel: 'european'
    });
    convars.mica_casino_crash_edge_pct = '45';
    expect((await call('config', {})).crash_edge_pct).toBe(20);
    convars.mica_casino_crash_edge_pct = '-2';
    expect((await call('config', {})).crash_edge_pct).toBe(0);
    convars.mica_casino_crash_edge_pct = 'lots';
    expect((await call('config', {})).crash_edge_pct).toBe(3);
  });

  it('grows the multiplier as 2^(t/10s), floored to ×100', () => {
    expect(multiplierAt(0)).toBe(100);
    expect(multiplierAt(1_000)).toBe(107);
    expect(multiplierAt(5_000)).toBe(141);
    expect(multiplierAt(10_000)).toBe(200);
    expect(multiplierAt(20_000)).toBe(400);
    expect(multiplierAt(-5_000)).toBe(100);
  });

  it('schedules the crash for the first millisecond the multiplier passes the point', () => {
    // A tie still wins, so the round is lost only once m is above the point.
    expect(crashDelayMs(199)).toBe(10_000);
    expect(crashDelayMs(100)).toBe(144);
    for (const cp of [100, 101, 137, 199, 250, 999, 12_345, CRASH_POINT_MAX]) {
      const t = crashDelayMs(cp);
      expect(multiplierAt(t), `cp ${cp}`).toBeGreaterThan(cp);
      expect(multiplierAt(t - 1), `cp ${cp}`).toBeLessThanOrEqual(cp);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Crash: rounds
// ---------------------------------------------------------------------------------------------

describe('crash: a round', () => {
  const start = async (cp: number, stake = 100) => {
    __setCrashDrawForTests(() => drawFor(cp));
    return call('crashStart', { stake });
  };

  it('debits first, stores the hidden point, and answers with the server clock', async () => {
    const reply = await start(250);
    // No `busted` key on a round in play.
    expect(reply).toStrictEqual({ round_id: 1, started_at: Date.now() });
    expect(debits()).toEqual([100]);
    expect(world.rows[0]).toMatchObject({
      game: 'crash',
      status: 'active',
      stake: 100,
      payout: 0,
      crash_point: 250
    });
    expect(JSON.parse(world.rows[0].result!)).toEqual({ started_at: Date.now() });
    expect(__isLiveForTests(1)).toBe(true);
  });

  it('pays the multiplier at the server time of the cash-out, and clears the timer', async () => {
    await start(250);
    vi.setSystemTime(Date.now() + 5_000);

    expect(await call('crashCashout', { round_id: 1 })).toEqual({
      ok: true,
      multiplier: 141,
      payout: 141
    });
    expect(credits()).toEqual([141]);
    expect(world.rows[0]).toMatchObject({ status: 'settled', multiplier: 141, payout: 141 });
    expect(__isLiveForTests(1)).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pushes).toEqual([]);
    expect(world.rows[0].payout).toBe(141);
  });

  it('pays a cash-out at exactly the point: a tie goes to the player', async () => {
    await start(250);
    const tie = 13_220;
    expect(multiplierAt(tie)).toBe(250);
    vi.setSystemTime(Date.now() + tie);

    expect(await call('crashCashout', { round_id: 1 })).toEqual({
      ok: true,
      multiplier: 250,
      payout: 250
    });
    expect(credits()).toEqual([250]);
    expect(world.rows[0]).toMatchObject({ status: 'settled', multiplier: 250, payout: 250 });
  });

  it('busts a cash-out that arrives after the point, before the timer has run', async () => {
    await start(250);
    vi.setSystemTime(Date.now() + crashDelayMs(250));

    expect(await call('crashCashout', { round_id: 1 })).toEqual({
      ok: false,
      reason: 'busted',
      crash_at: 250
    });
    expect(money.addMoney).not.toHaveBeenCalled();
    expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 0, multiplier: null });
    expect(__isLiveForTests(1)).toBe(false);
  });

  it('pays a 1.00 point back at break-even when cashed out at once', async () => {
    await start(100);
    expect(await call('crashCashout', { round_id: 1 })).toEqual({
      ok: true,
      multiplier: 100,
      payout: 100
    });
  });

  it('settles an instant bust inside crashStart, pushes it after the reply, and frees the key', async () => {
    __setCrashDrawForTests(() => 1);
    const reply = await call('crashStart', { stake: 100 });

    // The reply carries the bust, so the app can close the round without waiting on the push.
    expect(reply).toEqual({ round_id: 1, started_at: Date.now(), busted: { crash_at: 100 } });
    expect(debits()).toEqual([100]);
    expect(world.rows[0]).toMatchObject({
      game: 'crash',
      status: 'settled',
      payout: 0,
      multiplier: null,
      crash_point: 100
    });
    expect(__isLiveForTests(1)).toBe(false);
    // The push waits a turn, so the app has the round id before it hears the crash.
    expect(pushes).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pushes).toEqual([
      { to: 'CID_A', event: 'crash', payload: { round_id: 1, crash_at: 100 } }
    ]);

    expect(await call('crashCashout', { round_id: 1 })).toEqual({
      ok: false,
      reason: 'busted',
      crash_at: 100
    });
    expect(money.addMoney).not.toHaveBeenCalled();
    expect(await call('crashState', {})).toBeNull();
    expect(await start(250)).toMatchObject({ round_id: 2 });
  });

  it('settles the round as lost when the timer fires, and pushes the crash', async () => {
    await start(250);
    await vi.advanceTimersByTimeAsync(crashDelayMs(250) - 1);
    expect(world.rows[0].status).toBe('active');
    expect(pushes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 0 });
    expect(pushes).toEqual([
      { to: 'CID_A', event: 'crash', payload: { round_id: 1, crash_at: 250 } }
    ]);
    expect(__isLiveForTests(1)).toBe(false);

    expect(await call('crashCashout', { round_id: 1 })).toEqual({
      ok: false,
      reason: 'busted',
      crash_at: 250
    });
    expect(money.addMoney).not.toHaveBeenCalled();
  });

  it('keeps the settle when the push throws', async () => {
    await start(150);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    pushes.push = () => {
      throw new Error('push failed');
    };
    try {
      await vi.advanceTimersByTimeAsync(crashDelayMs(150));
      expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 0 });
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/push/), expect.any(Error));
    } finally {
      delete (pushes as { push?: unknown }).push;
      error.mockRestore();
    }
  });

  it('retries a failing timer settle on a backoff, never dropping the round', async () => {
    await start(150);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) dbMock.update.mockRejectedValueOnce(new Error('deadlock'));
    await vi.advanceTimersByTimeAsync(crashDelayMs(150));
    // Five failures, retried after 5s, 10s, 20s, 40s and 60s (the cap): 135s in all.
    await vi.advanceTimersByTimeAsync(134_999);
    expect(world.rows[0].status).toBe('active');
    expect(__isLiveForTests(1)).toBe(true);
    expect(error).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(1);
    expect(world.rows[0].status).toBe('settled');
    expect(__isLiveForTests(1)).toBe(false);
    expect(pushes).toHaveLength(1);
    error.mockRestore();
  });

  it('pays a cash-out handled before the crash when a settle lands during its read', async () => {
    await start(250);
    vi.setSystemTime(Date.now() + 5_000);
    // A lost-settle lands while the cash-out is reading its round. The cash-out was handled at
    // 1.41×, below the point, and the handling moment is the one that counts.
    world.duringRead = () => {
      const row = world.rows[0];
      row.status = 'settled';
      row.payout = 0;
    };
    const reply = await call('crashCashout', { round_id: 1 });
    expect(reply).toEqual({ ok: true, multiplier: 141, payout: 141 });
    expect(credits()).toEqual([141]);
    expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 141, multiplier: 141 });
  });

  it('pays it when the timer itself fires during the read, after dropping the round', async () => {
    await start(250);
    vi.setSystemTime(Date.now() + 5_000);
    world.duringRead = () => vi.advanceTimersByTime(crashDelayMs(250));

    const reply = await call('crashCashout', { round_id: 1 });
    expect(reply).toEqual({ ok: true, multiplier: 141, payout: 141 });
    expect(credits()).toEqual([141]);
    expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 141, multiplier: 141 });
    // The timer had already told the app it crashed; the reply is what decides.
    expect(pushes).toHaveLength(1);

    // And only once: a second cash-out finds it paid.
    expect(await call('crashCashout', { round_id: 1 })).toEqual({ ok: false, reason: 'not_found' });
    expect(credits()).toEqual([141]);
  });

  it('never pays late a cash-out handled after the crash', async () => {
    await start(250);
    await vi.advanceTimersByTimeAsync(crashDelayMs(250));
    expect(world.rows[0].status).toBe('settled');
    expect(await call('crashCashout', { round_id: 1 })).toEqual({
      ok: false,
      reason: 'busted',
      crash_at: 250
    });
    expect(money.addMoney).not.toHaveBeenCalled();
  });

  it('settles a cash-out racing the timer once: the cash-out wins, no crash is pushed', async () => {
    await start(250);
    vi.setSystemTime(Date.now() + 5_000);
    expect(await call('crashCashout', { round_id: 1 })).toMatchObject({ ok: true, payout: 141 });
    // The timer was cleared with the cash-out, so the point passing changes nothing.
    await vi.advanceTimersByTimeAsync(crashDelayMs(250));
    expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 141 });
    expect(pushes).toEqual([]);
    expect(credits()).toEqual([141]);
  });

  it('pays two racing cash-outs once', async () => {
    await start(250);
    vi.setSystemTime(Date.now() + 5_000);
    // One reply capture for both, told apart by callback id: each `call` installs its own.
    (globalThis as any).source = 1;
    const emit = vi.fn();
    (globalThis as any).emitNet = emit;
    const cashout = handlers.get('mica:server:casino:crashCashout')!;
    await Promise.all([cashout('cb-a', { round_id: 1 }), cashout('cb-b', { round_id: 1 })]);
    const replyTo = (cbId: string) => emit.mock.calls.find((args) => args.includes(cbId))?.[3];
    const [a, b] = [replyTo('cb-a'), replyTo('cb-b')];
    expect([a, b]).toContainEqual({ ok: true, multiplier: 141, payout: 141 });
    expect([a, b]).toContainEqual({ ok: false, reason: 'not_found' });
    expect(credits()).toEqual([141]);
  });

  it("refuses another citizen's round, and a round already cashed out", async () => {
    await start(250);
    wallet.citizenid = 'CID_B';
    vi.setSystemTime(Date.now() + 5_000);
    expect(await call('crashCashout', { round_id: 1 })).toEqual({ ok: false, reason: 'not_found' });
    expect(world.rows[0].status).toBe('active');
    expect(money.addMoney).not.toHaveBeenCalled();

    wallet.citizenid = 'CID_A';
    expect(await call('crashCashout', { round_id: 1 })).toMatchObject({ ok: true });
    expect(await call('crashCashout', { round_id: 1 })).toEqual({ ok: false, reason: 'not_found' });
    expect(credits()).toEqual([141]);
  });

  it('allows one round in play per citizen, before any money moves', async () => {
    await start(250);
    expect(await start(300)).toEqual({ ok: false, reason: 'round_active' });
    expect(debits()).toEqual([100]);

    wallet.citizenid = 'CID_B';
    expect(await start(300)).toMatchObject({ round_id: 2 });
  });

  it('refunds a start that loses the race to the unique key', async () => {
    world.insertFails = new Error("Duplicate entry 'CID_A' for key 'active_crash'");
    expect(await start(250)).toEqual({ ok: false, reason: 'round_active' });
    expect(debits()).toEqual([100]);
    expect(credits()).toEqual([100]);
    expect(world.rows).toEqual([]);
  });

  it('refunds a start whose round cannot be recorded, and logs a failed refund', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.insertFails = new Error('Lost connection to MySQL server');
    money.addMoney.mockReturnValue(false);
    expect(await start(250)).toEqual({ ok: false, reason: 'round_failed' });
    expect(credits()).toEqual([100]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not credit 100 to CID_A/));
    expect(__isLiveForTests(1)).toBe(false);
    error.mockRestore();
  });

  it('refuses a stake outside the table limits, and a short balance', async () => {
    expect(await start(250, 9)).toEqual({ ok: false, reason: 'below_min' });
    expect(await start(250, 5001)).toEqual({ ok: false, reason: 'above_max' });
    wallet.bank = 50;
    expect(await start(250, 100)).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(money.removeMoney).not.toHaveBeenCalled();
    expect(world.rows).toEqual([]);
  });

  it('refuses a start from a player holding no phone, but never a cash-out', async () => {
    await start(250);
    refusePhone();
    expect(await start(300)).toEqual(NOT_HELD_REPLY);
    vi.setSystemTime(Date.now() + 5_000);
    expect(await call('crashCashout', { round_id: 1 })).toMatchObject({ ok: true });
  });

  it('answers the live round for crashState, and null once it settles', async () => {
    const { started_at } = await start(250);
    expect(await call('crashState', {})).toEqual({ round_id: 1, stake: 100, started_at });
    wallet.citizenid = 'CID_B';
    expect(await call('crashState', {})).toBeNull();
    wallet.citizenid = 'CID_A';
    await vi.advanceTimersByTimeAsync(crashDelayMs(250));
    expect(await call('crashState', {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------------------------

describe('crash: a restart mid-round', () => {
  const orphan = (id: number, startedAt: number): Row => ({
    id,
    citizenid: 'CID_A',
    game: 'crash',
    status: 'active',
    stake: 100,
    payout: 0,
    multiplier: null,
    crash_point: 300,
    result: JSON.stringify({ started_at: startedAt }),
    created_at: '2026-10-18 11:00:00'
  });

  it('settles a round left in play by an earlier process as lost, and keeps the stake', async () => {
    world.rows.push(orphan(1, 1_000));
    world.nextId = 1;

    expect(await sweepStaleCrashRounds()).toBe(1);
    expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 0 });
    expect(money.addMoney).not.toHaveBeenCalled();
    expect(pushes).toEqual([]);

    // The citizen can play again.
    __setCrashDrawForTests(() => drawFor(200));
    expect(await call('crashStart', { stake: 100 })).toMatchObject({ round_id: 2 });
  });

  it('never settles a round this process started', async () => {
    world.rows.push(orphan(1, 1_000));
    world.nextId = 1;
    wallet.citizenid = 'CID_B';
    __setCrashDrawForTests(() => drawFor(500));
    await call('crashStart', { stake: 100 });

    expect(await sweepStaleCrashRounds()).toBe(1);
    expect(world.rows.map((r) => [r.id, r.status])).toEqual([
      [1, 'settled'],
      [2, 'active']
    ]);
    expect(__isLiveForTests(2)).toBe(true);
  });

  it('answers an orphan cash-out as busted, and crashState as nothing', async () => {
    world.rows.push(orphan(1, 1_000));
    world.nextId = 1;
    expect(await call('crashState', {})).toBeNull();
    expect(await call('crashCashout', { round_id: 1 })).toEqual({
      ok: false,
      reason: 'busted',
      crash_at: 300
    });
    expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 0 });
    expect(money.addMoney).not.toHaveBeenCalled();
  });

  it('settles a refunded insert that committed anyway once its time is up, and frees the key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    __setCrashDrawForTests(() => drawFor(250));
    world.insertCommitsThenFails = true;
    expect(await call('crashStart', { stake: 100 })).toEqual({ ok: false, reason: 'round_failed' });
    expect(credits()).toEqual([100]);
    expect(world.rows[0]).toMatchObject({ id: 1, status: 'active' });
    expect(__isLiveForTests(1)).toBe(false);

    // It can never pay: no start is known for it here.
    vi.setSystemTime(Date.now() + 1_000);
    expect(await call('crashCashout', { round_id: 1 })).toMatchObject({ reason: 'busted' });
    expect(credits()).toEqual([100]);
    world.rows[0].status = 'active';

    // Before its crash time it still holds the key; after it, the start sweeps it and retries.
    expect(await call('crashStart', { stake: 100 })).toEqual({ ok: false, reason: 'round_active' });
    vi.setSystemTime(Date.now() + crashDelayMs(250));
    expect(await call('crashStart', { stake: 100 })).toMatchObject({ round_id: 2 });
    expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 0 });
    expect(debits()).toEqual([100, 100]);
    error.mockRestore();
  });

  it('leaves a row alone while its start is still waiting on the insert', async () => {
    __setCrashDrawForTests(() => drawFor(100));
    let swept: Promise<number> | undefined;
    world.duringInsert = () => {
      // Committed, timer not yet scheduled, and already past a 1.00 point's crash time.
      vi.setSystemTime(Date.now() + 1_000);
      swept = sweepStaleCrashRounds();
    };
    expect(await call('crashStart', { stake: 100 })).toMatchObject({ round_id: 1 });
    expect(await swept).toBe(0);
    expect(world.rows[0].status).toBe('active');
    expect(__isLiveForTests(1)).toBe(true);
  });

  it('sweeps again every minute after start', async () => {
    __setSchemaReadyForTests({ kind: 'existing' } as never);
    try {
      onCasinoResourceStart('mica');
      await vi.advanceTimersByTimeAsync(0);
      // A round left behind after the start-up sweep ran, its crash time long gone.
      world.rows.push(orphan(1, Date.now() - 200_000));
      await vi.advanceTimersByTimeAsync(STALE_SWEEP_MS - 1);
      expect(world.rows[0].status).toBe('active');
      await vi.advanceTimersByTimeAsync(1);
      expect(world.rows[0]).toMatchObject({ status: 'settled', payout: 0 });
    } finally {
      __setSchemaReadyForTests(null);
    }
  });

  it('runs on this resource start once the schema has settled', async () => {
    world.rows.push(orphan(1, 1_000));
    __setSchemaReadyForTests({ kind: 'existing' } as never);
    try {
      onCasinoResourceStart('some-other-resource');
      await vi.advanceTimersByTimeAsync(0);
      expect(world.rows[0].status).toBe('active');

      onCasinoResourceStart('mica');
      await vi.advanceTimersByTimeAsync(0);
      expect(world.rows[0].status).toBe('settled');
    } finally {
      __setSchemaReadyForTests(null);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// History, and what leaves the server
// ---------------------------------------------------------------------------------------------

describe('history', () => {
  const seed = (n: number, citizenid = 'CID_A') => {
    for (let i = 0; i < n; i++) {
      world.nextId += 1;
      world.rows.push({
        id: world.nextId,
        citizenid,
        game: 'roulette',
        status: 'settled',
        stake: 10,
        payout: 0,
        multiplier: null,
        crash_point: null,
        result: JSON.stringify({ number: 4, bets: [{ kind: 'red', amount: 10 }] }),
        created_at: '2026-10-18 12:00:00'
      });
    }
  };

  it("pages the caller's own rounds, newest first, keyset on id", async () => {
    seed(3);
    seed(2, 'CID_B');
    seed(2);

    const first = await call('history', { limit: 3 });
    expect(first.rows.map((r: any) => r.id)).toEqual([7, 6, 3]);
    expect(first.nextCursor).toBe(3);
    const second = await call('history', { cursor: first.nextCursor, limit: 3 });
    expect(second.rows.map((r: any) => r.id)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();

    const [sql, params] = dbMock.query.mock.calls.at(-1)!;
    expect(one(sql)).toContain('WHERE `citizenid` = ?');
    expect(params?.[0]).toBe('CID_A');
  });

  it('caps a page at fifty', async () => {
    seed(60);
    const page = await call('history', { limit: 500 });
    expect(page.rows).toHaveLength(HISTORY_PAGING.maxPageSize);
    expect(page.nextCursor).toBe(11);
  });

  it('shapes a roulette row and hides the point of a round still in play', async () => {
    seed(1);
    __setCrashDrawForTests(() => drawFor(777));
    await call('crashStart', { stake: 100 });

    const { rows } = await call('history', {});
    expect(rows[0]).toMatchObject({ id: 2, game: 'crash', status: 'active', crash_point: null });
    expect(rows[0].number).toBeNull();
    expect(rows[1]).toEqual({
      id: 1,
      game: 'roulette',
      status: 'settled',
      stake: 10,
      payout: 0,
      multiplier: null,
      crash_point: null,
      number: 4,
      bets: [{ kind: 'red', amount: 10 }],
      created_at: '2026-10-18 12:00:00'
    });

    await vi.advanceTimersByTimeAsync(crashDelayMs(777));
    const after = await call('history', {});
    expect(after.rows[0]).toMatchObject({ id: 2, status: 'settled', crash_point: 777 });
  });

  it('keeps a live round out of the privacy export', () => {
    expect(exportFilterFor('mica_casino_rounds')).toEqual({
      sql: "`status` <> 'active'",
      params: []
    });
  });
});
