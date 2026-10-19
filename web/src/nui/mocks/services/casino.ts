// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MockHandler } from '../registry';

/**
 * The Casino's server, in the browser (MICA-82): every action `server/services/Casino.ts`
 * registers, answering its shape, refusing what it refuses, and pushing `crash` when a round
 * ends — so `pnpm dev` and Playwright play the game rather than receive canned answers.
 *
 * The rules are restated here rather than imported from the app: the app is an add-on and
 * this is core, so nothing in core reaches into `apps/` (and the app's copy is a mirror of
 * the server's, not the authority either).
 */

const CONFIG = { bet_min: 10, bet_max: 5000, crash_edge_pct: 3, wheel: 'european' as const };

/** A stand-in bank account. The real one is the framework's; the mock keeps its own. */
let balance = 25_000;

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n: number) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
const ODDS: Record<string, number> = {
  straight: 35,
  dozen: 2,
  column: 2,
  red: 1,
  black: 1,
  odd: 1,
  even: 1,
  low: 1,
  high: 1
};
const RANGE: Record<string, [number, number]> = {
  straight: [0, 36],
  dozen: [1, 3],
  column: [1, 3]
};

interface MockBet {
  kind: string;
  value?: number;
  amount: number;
}

const wins = (bet: MockBet, n: number): boolean => {
  if (bet.kind === 'straight') return bet.value === n;
  if (n === 0) return false;
  switch (bet.kind) {
    case 'red':
    case 'black':
      return colorOf(n) === bet.kind;
    case 'odd':
      return n % 2 === 1;
    case 'even':
      return n % 2 === 0;
    case 'low':
      return n <= 18;
    case 'high':
      return n >= 19;
    case 'dozen':
      return Math.ceil(n / 12) === bet.value;
    case 'column':
      return ((n - 1) % 3) + 1 === bet.value;
    default:
      return false;
  }
};

/** m(t) = 2^(t / 10s), as an integer ×100, floored. */
const multiplierAt = (elapsedMs: number) =>
  Math.floor(100 * 2 ** (Math.max(0, elapsedMs) / 10_000));
/**
 * A cash-out at m wins while m ≤ the point: a tie goes to the player. The round is lost from
 * the first millisecond m passes the point — when the floored m first reaches point + 0.01 —
 * which is `crashDelayMs` on the server, rounded up to the next millisecond.
 */
const crashDelayMs = (point: number) =>
  Math.max(0, Math.ceil(10_000 * Math.log2((point + 1) / 100)));

/**
 * Where a round will crash, ×100, or `null` for an instant bust — `crashPointFor` on the server.
 * raw = (1 − e/100)/u with `u` uniform in (0, 1]. Below 1.00 the round busts at the start, which
 * happens with probability e exactly; otherwise the point is floor(raw·100), capped at 1000.00.
 * A cash-out at x wins exactly when raw ≥ x/100, so P(win at x) = (1 − e/100)·100/x and every
 * target returns 1 − e of the stake: the edge is the convar, with nothing added by rounding.
 */
const crashPoint = (edgePct: number, u = 1 - Math.random()): number | null => {
  const raw = (1 - edgePct / 100) / u;
  if (raw < 1) return null;
  return Math.min(100_000, Math.floor(raw * 100));
};

/** `CasinoRound` from `@mica/shared/types`, as `history` pages it. */
interface MockRound {
  id: number;
  game: 'roulette' | 'crash';
  status: 'active' | 'settled';
  stake: number;
  payout: number;
  multiplier: number | null;
  crash_point: number | null;
  number: number | null;
  bets: MockBet[] | null;
  created_at: string;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const roulette = (id: number, number: number, bets: MockBet[], at: string): MockRound => ({
  id,
  game: 'roulette',
  status: 'settled',
  stake: bets.reduce((total, bet) => total + bet.amount, 0),
  payout: bets.reduce(
    (total, bet) => total + (wins(bet, number) ? bet.amount * (ODDS[bet.kind] + 1) : 0),
    0
  ),
  multiplier: null,
  crash_point: null,
  number,
  bets,
  created_at: at
});

const crashRow = (id: number, stake: number, at: string): MockRound => ({
  id,
  game: 'crash',
  status: 'active',
  stake,
  payout: 0,
  multiplier: null,
  crash_point: null,
  number: null,
  bets: null,
  created_at: at
});

/** Seeded so History is not empty on first open. Ids only grow. */
const rounds: MockRound[] = [
  roulette(1, 17, [{ kind: 'red', amount: 100 }], minutesAgo(95)),
  {
    ...crashRow(2, 250, minutesAgo(60)),
    status: 'settled',
    payout: 412,
    multiplier: 165,
    crash_point: 231
  },
  roulette(3, 8, [{ kind: 'even', amount: 50 }], minutesAgo(31)),
  { ...crashRow(4, 100, minutesAgo(12)), status: 'settled', crash_point: 112 }
];
let nextRoundId = 5;

interface LiveCrash {
  round_id: number;
  stake: number;
  started_at: number;
  crash_at: number;
  timer: ReturnType<typeof setTimeout>;
}

let live: LiveCrash | null = null;

/** The server's `casino:crash` push, over the message the real one travels by. */
const announceCrash = (payload: { round_id: number; crash_at: number }): void => {
  if (typeof window === 'undefined') return;
  window.postMessage(
    { action: 'appEvent', data: { app: 'casino', event: 'crash', payload, at: Date.now() } },
    '*'
  );
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * A kind the table has — its own key, never one off the prototype (`'toString' in ODDS` is
 * true). `Object.hasOwn` would say it better, but web's TS lib stops short of ES2022.
 */
const isKind = (kind: unknown): kind is string =>
  typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ODDS, kind);

/**
 * A refusal, **returned** as the server returns it (`CasinoRefusal`), so the app words it.
 * A payload the contract's schema refuses is thrown instead, as the server's parse throws.
 */
const refuse = (reason: string) => ({ ok: false as const, reason });
const unparseable = () => new Error('Invalid request.');

/** Settle the live round as lost at its crash point. */
const bust = (round: LiveCrash): void => {
  const row = rounds.find((r) => r.id === round.round_id);
  if (row) Object.assign(row, { status: 'settled', payout: 0, crash_point: round.crash_at });
};

export const mocks: Record<string, MockHandler> = {
  'casino:config': () => ({ ...CONFIG }),
  'casino:spin': ({ bets }: { bets?: unknown } = {}) => {
    // The contract's schema: 1..20 bets, a known kind, an int value in 0..36, a positive amount.
    if (!Array.isArray(bets) || bets.length === 0 || bets.length > 20) throw unparseable();
    for (const raw of bets as MockBet[]) {
      if (!raw || typeof raw !== 'object' || !isKind(raw.kind)) throw unparseable();
      if (raw.value !== undefined && (!isInt(raw.value) || raw.value < 0 || raw.value > 36)) {
        throw unparseable();
      }
      if (!isInt(raw.amount) || raw.amount < 1) throw unparseable();
    }
    const placed = bets as MockBet[];
    // The handler: the value each kind needs, then the table limits, then the bank.
    const wellFormed = placed.every((bet) => {
      const range = RANGE[bet.kind];
      return range
        ? isInt(bet.value) && bet.value >= range[0] && bet.value <= range[1]
        : bet.value === undefined;
    });
    if (!wellFormed) return refuse('invalid_bet');
    if (placed.some((bet) => bet.amount < CONFIG.bet_min)) return refuse('below_min');
    const stake = placed.reduce((total, bet) => total + bet.amount, 0);
    if (stake > CONFIG.bet_max) return refuse('above_max');
    if (stake > balance) return refuse('insufficient_funds');
    const number = Math.floor(Math.random() * 37);
    const round = roulette(nextRoundId++, number, placed, new Date().toISOString());
    rounds.push(round);
    balance += round.payout - stake;
    return { round_id: round.id, number, color: colorOf(number), stake, payout: round.payout };
  },
  'casino:crashStart': ({ stake }: { stake?: unknown } = {}) => {
    if (!isInt(stake) || stake < 1) throw unparseable();
    if (stake < CONFIG.bet_min) return refuse('below_min');
    if (stake > CONFIG.bet_max) return refuse('above_max');
    if (live) return refuse('round_active');
    if (stake > balance) return refuse('insufficient_funds');
    balance -= stake;
    const round_id = nextRoundId++;
    const started_at = Date.now();
    const drawn = crashPoint(CONFIG.crash_edge_pct);
    const row = crashRow(round_id, stake, new Date(started_at).toISOString());
    rounds.push(row);
    if (drawn === null) {
      // An instant bust: recorded at 1.00×, already settled at payout 0, so no cash-out can land
      // on it. The push still goes out, on the next turn, after this reply; the reply says so too,
      // since in game the push can overtake it.
      Object.assign(row, { status: 'settled', payout: 0, crash_point: 100 });
      setTimeout(() => announceCrash({ round_id, crash_at: 100 }), 0);
      return { round_id, started_at, busted: { crash_at: 100 } };
    }
    const crash_at = drawn;
    const timer = setTimeout(() => {
      if (live?.round_id !== round_id) return;
      bust(live);
      live = null;
      announceCrash({ round_id, crash_at });
    }, crashDelayMs(crash_at));
    live = { round_id, stake, started_at, crash_at, timer };
    return { round_id, started_at };
  },
  'casino:crashCashout': ({ round_id }: { round_id?: unknown } = {}) => {
    if (!isInt(round_id) || round_id < 1) throw unparseable();
    if (!live || live.round_id !== round_id) {
      const row = rounds.find((r) => r.id === round_id && r.game === 'crash');
      // A settled round: a bust says where, one already cashed out is not there.
      return row && row.payout === 0 && row.crash_point !== null
        ? { ok: false, reason: 'busted', crash_at: row.crash_point }
        : { ok: false, reason: 'not_found' };
    }
    const round = live;
    const multiplier = multiplierAt(Date.now() - round.started_at);
    clearTimeout(round.timer);
    live = null;
    // A tie goes to the player: the round is lost only once the multiplier is past the point.
    if (multiplier > round.crash_at) {
      bust(round);
      return { ok: false, reason: 'busted', crash_at: round.crash_at };
    }
    const payout = Math.floor((round.stake * multiplier) / 100);
    balance += payout;
    const row = rounds.find((r) => r.id === round.round_id);
    if (row) {
      Object.assign(row, { status: 'settled', payout, multiplier, crash_point: round.crash_at });
    }
    return { ok: true, multiplier, payout };
  },
  'casino:crashState': () =>
    live ? { round_id: live.round_id, stake: live.stake, started_at: live.started_at } : null,
  'casino:history': ({ cursor, limit }: { cursor?: unknown; limit?: unknown } = {}) => {
    const size = isInt(limit) && limit > 0 ? Math.min(limit, 50) : 20;
    const eligible = rounds
      .filter((r) => cursor == null || (isInt(cursor) && r.id < cursor))
      .sort((a, b) => b.id - a.id);
    // The hidden outcome stays hidden until the round settles, as the server keeps it.
    const rows = eligible
      .slice(0, size)
      .map((r) => (r.status === 'active' ? { ...r, crash_point: null } : { ...r }));
    const nextCursor = eligible.length > rows.length ? rows[rows.length - 1].id : null;
    return { rows, nextCursor };
  }
};
