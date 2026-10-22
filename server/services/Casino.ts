// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import type { FrameworkPlayer } from '../lib/FrameworkBridge';
import { pageBounds } from '../lib/payload';
import { isDuplicateKey, reasonOf, traceOf } from '../lib/sqlErrors';
import { whenSchemaReady } from '../lib/schemaReady';
import { registerExportFilter } from './Privacy';
import { defineContract, responseType } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';
import type {
  CasinoBet,
  CasinoCrashRound,
  CasinoRound,
  CasinoSpinResult
} from '@mica/shared/types';
import { who } from '../lib/who';

/**
 * Casino (MICA-82): European roulette and Crash, staked in bank cash through the framework.
 *
 * Every outcome is decided here, from `node:crypto`, and the client only draws it. The roulette
 * number is drawn after the stake is debited. The crash point is drawn at `crashStart`, kept in
 * `crash_point` and in this process's memory, and the client never sees it before the round
 * settles. `history` hides it on a live round, and the privacy export skips live rounds.
 * The Crash multiplier is a function of the **server's** clock since the round began, and the
 * time a cash-out arrives here is the only time that counts.
 *
 * The house edge: roulette's is the single zero (1/37, 2.70%) and is not configurable. Crash's
 * is `mica_casino_crash_edge_pct`, exactly: a round busts instantly with probability e, and a
 * cash-out at any x wins with probability (1 − e)/x, so every target returns 1 − e of the stake
 * on average (see `crashPointFor`).
 *
 * Money moves the way `Hodlr.ts` moves it (MICA-134): the balance check and the debit are one
 * synchronous span (`debit`, which cannot contain an `await` because it is not async), and
 * every later failure refunds and logs loudly if the refund fails too.
 * `moneyAtomicity.test.ts` lists this file.
 */

/** The app id, and the contract's. */
export const CASINO_APP = 'casino';

const TABLE = 'mica_casino_rounds';

export const BET_KINDS = [
  'straight',
  'red',
  'black',
  'odd',
  'even',
  'low',
  'high',
  'dozen',
  'column'
] as const;

/** The most bets one spin may carry. */
export const MAX_BETS = 20;

/** `int(11)`'s ceiling. The convar bounds a real bet much lower; this bounds the payload. */
const INT_MAX = 2147483647;

/** History pages: newest first, keyset on `id`, at most 50 a page. */
export const HISTORY_PAGING = { pageSize: 20, maxPageSize: 50 } as const;

/** The crash point's ceiling, ×100: a round never runs past 1000.00×. */
export const CRASH_POINT_MAX = 100_000;

export type CasinoRefusal<R extends string> = { ok: false; reason: R };

type StakeRefusal = 'below_min' | 'above_max' | 'insufficient_funds' | 'debit_failed';

export type SpinRefusal = 'invalid_bet' | StakeRefusal | 'round_failed';
export type CrashStartRefusal = 'round_active' | StakeRefusal | 'round_failed';

export type CashoutReply =
  | { ok: true; multiplier: number; payout: number }
  | { ok: false; reason: 'busted'; crash_at: number }
  | { ok: false; reason: 'not_found' };

/**
 * Casino's contract, declared beside its `defineService` for Hodlr's and Spark's reason:
 * Casino is `core: false`, and core may not name an app the Store installs
 * (`sdk/coreBoundary.test.ts`).
 *
 * Every generic action is off. No payload authorizes anything: every handler reads and settles
 * rounds by the session's citizenid, never by a row id alone (§2.9). A refusal is returned as
 * `{ ok: false, reason }` rather than thrown, so the app can word it itself.
 */
export const casinoContract = defineContract({
  id: CASINO_APP,
  actions: {
    /** The table limits and the Crash edge, as the convars read now. */
    config: {
      input: s.none(),
      output: responseType<{
        bet_min: number;
        bet_max: number;
        crash_edge_pct: number;
        wheel: 'european';
      }>()
    },
    /**
     * One spin over 1..20 bets. `value` is required for straight (0..36), dozen and column
     * (1..3), and refused on every other kind; that half is checked in the handler, since it
     * depends on `kind`.
     */
    spin: {
      input: s.object({
        bets: s.array(
          s.object({
            kind: s.enum(BET_KINDS),
            value: s.int({ min: 0, max: 36 }).optional(),
            amount: s.int({ min: 1, max: INT_MAX })
          }),
          { min: 1, max: MAX_BETS }
        )
      }),
      output: responseType<CasinoSpinResult | CasinoRefusal<SpinRefusal>>()
    },
    /** Stake one Crash round. One round in play per citizen. */
    crashStart: {
      input: s.object({ stake: s.int({ min: 1, max: INT_MAX }) }),
      output: responseType<
        | (Pick<CasinoCrashRound, 'round_id' | 'started_at'> & {
            /** Present only for an instant bust: the round is already settled at 1.00×. */
            busted?: { crash_at: number };
          })
        | CasinoRefusal<CrashStartRefusal>
      >()
    },
    /** Cash the caller's own live round out at the multiplier the server's clock says now. */
    crashCashout: {
      input: s.object({ round_id: s.positiveInt() }),
      output: responseType<CashoutReply>()
    },
    /** The caller's round in play, or null, so the app picks a live round back up. */
    crashState: { input: s.none(), output: responseType<CasinoCrashRound | null>() },
    /** The caller's own rounds, newest first, keyset-paged. */
    history: {
      input: s.object({
        cursor: s.positiveInt().optional(),
        limit: s.positiveInt().optional()
      }),
      output: responseType<{ rows: CasinoRound[]; nextCursor: number | null }>()
    }
  }
});

interface CasinoRoundRow {
  id: number;
  citizenid: string;
  game: 'roulette' | 'crash';
  stake: number;
  payout: number;
  multiplier: number | null;
  crash_point: number | null;
  result: string | null;
  status?: 'active' | 'settled' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

export const casino = defineService<CasinoRoundRow, typeof casinoContract>({
  contract: casinoContract,
  id: CASINO_APP,
  app: CASINO_APP,
  table: TABLE,
  access: { read: 'owner', write: 'server' },
  // `active` is a Crash round in play. Roulette rows are written `settled`, because a spin is
  // decided before its row exists. `deleted` is required by `defineService`, and nothing here
  // writes it.
  statuses: ['active', 'settled', 'deleted'],
  schema: {
    game: { type: 'enum', values: ['roulette', 'crash'], notNull: true },
    /** Whole bank cash debited for the round: a spin's total, or a Crash stake. */
    stake: { type: 'int', notNull: true },
    /** Whole bank cash credited back after the round. 0 for a loss. */
    payout: { type: 'int', notNull: true, default: 0 },
    /** The Crash cash-out, ×100. Null for a bust and for roulette. */
    multiplier: 'int',
    /** The hidden Crash point, ×100. The outcome until the round settles. */
    crash_point: { type: 'int', private: true },
    /** JSON: roulette's `{ number, bets }`, Crash's `{ started_at }` (server epoch ms). */
    result: 'text',
    /**
     * The citizen of a Crash round in play and NULL on every other row, so the unique key
     * below allows one live round per citizen. The database enforces it, so two
     * `crashStart`s racing past the read cannot both insert.
     */
    active_crash: {
      type: 'string',
      citizenId: true,
      generatedAs:
        "CASE WHEN `status` = 'active' AND `game` = 'crash' THEN `citizenid` ELSE NULL END"
    }
  },
  indexes: [{ name: 'active_crash', columns: ['active_crash'], unique: true }],
  uniqueAfterDelete: {
    optOut:
      'the key is NULL on every row but a Crash round in play, so a settled or deleted round ' +
      'holds nothing; and no generic create exists to revive through'
  },
  options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true }
});

const app = casino.app;

// ---------------------------------------------------------------------------------------------
// Convars: read per call, the way Hodlr reads `mica_hodlr_trade_max`.
// ---------------------------------------------------------------------------------------------

const BET_MIN_CONVAR = 'mica_casino_bet_min';
const BET_MAX_CONVAR = 'mica_casino_bet_max';
const CRASH_EDGE_CONVAR = 'mica_casino_crash_edge_pct';

export const DEFAULT_BET_MIN = 10;
export const DEFAULT_BET_MAX = 5000;
export const DEFAULT_CRASH_EDGE_PCT = 3;

/**
 * The most `mica_casino_bet_max` may raise a stake to: a Crash payout runs to 1000× the stake
 * and must still fit `int(11)`. This keeps it under the ceiling with room to spare.
 */
export const BET_MAX_CEILING = 2_000_000;

/**
 * A whole number above zero, or the default. Each `GetConvar` below names its convar by its
 * own const, so `convars.test.ts` can read the name at the call site.
 */
const positiveIntOr = (raw: string, fallback: number): number => {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, BET_MAX_CEILING) : fallback;
};

export const betLimits = (): { bet_min: number; bet_max: number } => ({
  bet_min: positiveIntOr(GetConvar(BET_MIN_CONVAR, String(DEFAULT_BET_MIN)), DEFAULT_BET_MIN),
  bet_max: positiveIntOr(GetConvar(BET_MAX_CONVAR, String(DEFAULT_BET_MAX)), DEFAULT_BET_MAX)
});

/** Crash's house edge in percent: 0 is a fair game, and 20 is the most an owner may set. */
export const crashEdgePct = (): number => {
  const raw = Number.parseFloat(GetConvar(CRASH_EDGE_CONVAR, String(DEFAULT_CRASH_EDGE_PCT)));
  if (!Number.isFinite(raw)) return DEFAULT_CRASH_EDGE_PCT;
  return Math.min(20, Math.max(0, raw));
};

const refuse = <R extends string>(reason: R): CasinoRefusal<R> => ({ ok: false, reason });

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

/**
 * Debit `amount` from the bank, or say why not. **Synchronous on purpose (MICA-134):** the
 * balance read and the debit it gates cannot have an `await` between them, so nothing can
 * interleave between deciding and acting. Not a bare `<`: a balance the bridge could not
 * determine is `-Infinity` (see `Payments.transfer`).
 */
const debit = (player: FrameworkPlayer, amount: number): StakeRefusal | null => {
  const balance = player.getMoney('bank');
  if (!Number.isFinite(balance) || balance < amount) return 'insufficient_funds';
  if (!player.removeMoney('bank', amount)) return 'debit_failed';
  return null;
};

/**
 * Credit `amount` to the bank. A credit that fails is logged loudly with everything a server
 * owner needs to pay it by hand. That log line is the only remaining way to make the player
 * whole, since the money left (or was won) already.
 */
const credit = (player: FrameworkPlayer, amount: number, what: string): boolean => {
  if (player.addMoney('bank', amount)) return true;
  console.error(
    `[casino] ${what}: could not credit ${amount} to ${who(player.citizenid)}'s bank. ` +
      'Pay it by hand.'
  );
  return false;
};

// ---------------------------------------------------------------------------------------------
// Roulette
// ---------------------------------------------------------------------------------------------

/** The standard red set of a European wheel. */
export const RED_NUMBERS: ReadonlySet<number> = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36
]);

export const colorOf = (n: number): 'red' | 'black' | 'green' =>
  n === 0 ? 'green' : RED_NUMBERS.has(n) ? 'red' : 'black';

/** `value` is present exactly where the kind needs one, and in that kind's range. */
export const betIsWellFormed = (bet: CasinoBet): boolean => {
  switch (bet.kind) {
    case 'straight':
      return bet.value !== undefined && bet.value >= 0 && bet.value <= 36;
    case 'dozen':
    case 'column':
      return bet.value !== undefined && bet.value >= 1 && bet.value <= 3;
    default:
      return bet.value === undefined;
  }
};

/**
 * What one bet returns on `n`: the amount plus its winnings, or 0. A straight pays 35:1, a
 * dozen or column 2:1, everything else 1:1. Zero loses every outside bet, which is the
 * single-zero edge. There is no la partage.
 */
export const betReturn = (bet: CasinoBet, n: number): number => {
  const v = bet.value ?? -1;
  let wins: boolean;
  let odds: number;
  switch (bet.kind) {
    case 'straight':
      return n === v ? bet.amount * 36 : 0;
    case 'dozen':
      wins = n >= 12 * (v - 1) + 1 && n <= 12 * v;
      odds = 2;
      break;
    case 'column':
      wins = n !== 0 && ((n - 1) % 3) + 1 === v;
      odds = 2;
      break;
    case 'red':
      wins = colorOf(n) === 'red';
      odds = 1;
      break;
    case 'black':
      wins = colorOf(n) === 'black';
      odds = 1;
      break;
    case 'odd':
      wins = n !== 0 && n % 2 === 1;
      odds = 1;
      break;
    case 'even':
      wins = n !== 0 && n % 2 === 0;
      odds = 1;
      break;
    case 'low':
      wins = n >= 1 && n <= 18;
      odds = 1;
      break;
    case 'high':
      wins = n >= 19 && n <= 36;
      odds = 1;
      break;
  }
  return wins ? bet.amount * (odds + 1) : 0;
};

export const spinPayout = (bets: readonly CasinoBet[], n: number): number =>
  bets.reduce((sum, bet) => sum + betReturn(bet, n), 0);

/** 2^48: the span of one 6-byte draw, and still exact in a double. */
const SPAN_48 = 2 ** 48;

/** A uniform integer in [0, 2^48), from the CSPRNG. */
const random48 = (): number => Number.parseInt(randomBytes(6).toString('hex'), 16);

/**
 * A uniform integer in [0, n), for n up to 2^48. Rejection rather than a bare `%`, which would
 * favour the low numbers by a hair: the draws above the largest multiple of n are thrown away.
 */
export const secureInt = (n: number, draw: () => number = random48): number => {
  const limit = Math.floor(SPAN_48 / n) * n;
  for (;;) {
    const r = draw();
    if (r < limit) return r % n;
  }
};

/** Uniform over 0..36, from the CSPRNG. Indirect so a suite can fix the wheel. */
let drawNumber = (): number => secureInt(37);

/** Tests only: fix the wheel, or restore it with no argument. */
export const __setWheelForTests = (fn?: () => number): void => {
  drawNumber = fn ?? (() => secureInt(37));
};

const INSERT_ROUND =
  'INSERT INTO `mica_casino_rounds` ' +
  '(`citizenid`, `game`, `status`, `stake`, `payout`, `multiplier`, `crash_point`, `result`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

app.registerEvent('config', async () => ({
  ...betLimits(),
  crash_edge_pct: crashEdgePct(),
  wheel: 'european' as const
}));

app.registerEvent('spin', async (_source, _cbId, data, citizenid, player) => {
  const bets: CasinoBet[] = data.bets.map(({ kind, value, amount }) =>
    value === undefined ? { kind, amount } : { kind, value, amount }
  );
  if (!bets.every(betIsWellFormed)) return refuse('invalid_bet');

  const { bet_min, bet_max } = betLimits();
  if (bets.some((bet) => bet.amount < bet_min)) return refuse('below_min');
  const stake = bets.reduce((sum, bet) => sum + bet.amount, 0);
  if (stake > bet_max) return refuse('above_max');

  const refused = debit(player, stake);
  if (refused) return refuse(refused);

  // Drawn after the debit, so no refusal can depend on the outcome.
  const number = drawNumber();
  const payout = spinPayout(bets, number);

  let roundId = 0;
  try {
    roundId = await Database.insert(INSERT_ROUND, [
      citizenid,
      'roulette',
      'settled',
      stake,
      payout,
      null,
      null,
      JSON.stringify({ number, bets })
    ]);
  } catch (error) {
    console.error(`[casino] spin for ${who(citizenid)} could not be recorded: ${reasonOf(error)}`);
  }
  if (!(roundId > 0)) {
    // No record of the round, so it did not happen: the whole stake goes back and nothing is
    // paid on the number that was drawn.
    credit(player, stake, `spin refund for an unrecorded round`);
    return refuse('round_failed');
  }

  if (payout > 0) credit(player, payout, `roulette round ${roundId} payout`);

  return { round_id: roundId, number, color: colorOf(number), stake, payout };
});

// ---------------------------------------------------------------------------------------------
// Crash
// ---------------------------------------------------------------------------------------------

/**
 * m(t) = 2^(t/10s), floored to ×100. A negative elapsed time (the clock stepped back) reads
 * as the start rather than below 1.00×.
 */
export const multiplierAt = (elapsedMs: number): number =>
  Math.floor(100 * 2 ** (Math.max(0, elapsedMs) / 10_000));

/**
 * A cash-out at m wins while m ≤ the point: **a tie goes to the player.** The round is lost from
 * the first millisecond m passes the point, which is when the floored m first reaches
 * point + 0.01: t = 10·log2((point + 1)/100) seconds, rounded up to the next millisecond. At that
 * millisecond m is above the point, and one millisecond earlier it is not.
 */
export const crashDelayMs = (crashPoint: number): number =>
  Math.max(0, Math.ceil(10_000 * Math.log2((crashPoint + 1) / 100)));

/** The value `crashPointFor` answers for a round that busts before it starts. */
export const INSTANT_BUST = null;

/**
 * The crash point, ×100, for a uniform `u` in (0, 1], or `INSTANT_BUST`.
 *
 * raw = (1 − e/100)/u. Below 1.00 the round busts at the start, which has probability e
 * exactly, and no cash-out can land on it. Otherwise the point is floor(raw·100), capped at
 * 1000.00.
 *
 * A cash-out at x (×100, whole) wins when x ≤ point, which holds exactly when raw ≥ x/100. So
 * P(win at x) = (1 − e/100)·100/x, and the average return at every target is 1 − e. The edge is
 * the convar exactly, with nothing added by rounding.
 */
export const crashPointFor = (u: number, edgePct: number): number | null => {
  const raw = (1 - edgePct / 100) / u;
  if (raw < 1) return INSTANT_BUST;
  return Math.min(CRASH_POINT_MAX, Math.floor(raw * 100));
};

/** Uniform in (0, 1] from the CSPRNG: one of the 2^48 values (r + 1)/2^48. */
let drawUniform = (): number => (random48() + 1) / SPAN_48;

/** Tests only: fix the crash draw, or restore it with no argument. */
export const __setCrashDrawForTests = (fn?: () => number): void => {
  drawUniform = fn ?? (() => (random48() + 1) / SPAN_48);
};

/** A round in play in this process: the timer that busts it and what settling it needs. */
interface LiveRound {
  citizenid: string;
  stake: number;
  startedAt: number;
  crashPoint: number;
  timer: ReturnType<typeof setTimeout>;
}

const live = new Map<number, LiveRound>();

/**
 * Rounds the timer settled as lost in the last `BUSTED_MEMORY_MS`, with their start. A cash-out
 * handled before the crash but read after the timer's settle still needs the start to price
 * itself (see `payLate`), and the timer has already dropped the round from `live` by then.
 */
const bustedByTimer = new Map<number, number>();
const BUSTED_MEMORY_MS = 10_000;

/**
 * Citizens with a `crashStart` between its busy read and its insert's answer, and how many.
 * The stale sweep leaves their rows alone: the row may be committed before its timer exists.
 */
const starting = new Map<string, number>();

/**
 * When this process started. A round in the table that is still `active` but started before
 * this is one no timer here will ever settle (see `sweepStaleCrashRounds`).
 */
const BOOT_MS = Date.now();

/**
 * A timer settle that hits a database error tries again, and keeps trying: 5s, doubling, at most
 * a minute apart. A round is never dropped from memory unsettled, because its row would keep
 * the `active_crash` key and refuse its owner every new round.
 */
const SETTLE_RETRY_MS = 5_000;
const SETTLE_RETRY_MAX_MS = 60_000;

const crashChannel = appEventChannel(CASINO_APP);

/** Settle a live round as lost, only while it is still active: whoever settles first wins. */
const settleLost = (roundId: number): Promise<boolean> =>
  Database.update(
    "UPDATE `mica_casino_rounds` SET `status` = 'settled', `payout` = 0 " +
      "WHERE `id` = ? AND `status` = 'active'",
    [roundId]
  );

/** Drop a round from memory and cancel its timer. */
const forget = (roundId: number): void => {
  const round = live.get(roundId);
  if (!round) return;
  clearTimeout(round.timer);
  live.delete(roundId);
};

const pushCrash = (citizenid: string, roundId: number, crashAt: number): void => {
  try {
    crashChannel.push(citizenid, 'crash', { round_id: roundId, crash_at: crashAt });
  } catch (error) {
    console.error(`[casino] crash push for round ${roundId} failed:`, traceOf(error));
  }
};

/**
 * The timer's half: the multiplier has passed the point, so the round is lost. The push runs
 * only when this settle is the one that changed the row. A cash-out that got there first means
 * no push. A push failure is logged and never fails the settle.
 */
const onCrash = async (roundId: number, attempt = 1): Promise<void> => {
  const round = live.get(roundId);
  if (!round) return;

  let settled: boolean;
  try {
    settled = await settleLost(roundId);
  } catch (error) {
    if (live.get(roundId) !== round) return;
    const delay = Math.min(SETTLE_RETRY_MAX_MS, SETTLE_RETRY_MS * 2 ** (attempt - 1));
    console.error(
      `[casino] crash round ${roundId} for ${who(round.citizenid)} could not be settled ` +
        `(attempt ${attempt}): ${reasonOf(error)}. Trying again in ${delay / 1000}s.`
    );
    round.timer = setTimeout(() => void onCrash(roundId, attempt + 1), delay);
    return;
  }

  if (live.get(roundId) === round) live.delete(roundId);
  if (!settled) return;

  bustedByTimer.set(roundId, round.startedAt);
  setTimeout(() => bustedByTimer.delete(roundId), BUSTED_MEMORY_MS);
  pushCrash(round.citizenid, roundId, round.crashPoint);
};

const schedule = (roundId: number, round: Omit<LiveRound, 'timer'>): void => {
  const due = round.startedAt + crashDelayMs(round.crashPoint) - Date.now();
  const timer = setTimeout(() => void onCrash(roundId), Math.max(0, due));
  live.set(roundId, { ...round, timer });
};

/** Tests only: cancel every live timer and forget every round. */
export const __resetCasinoForTests = (): void => {
  for (const round of live.values()) clearTimeout(round.timer);
  live.clear();
  bustedByTimer.clear();
  starting.clear();
  if (staleSweep !== undefined) clearInterval(staleSweep);
  staleSweep = undefined;
};

/** Tests only: is this round in play in this process? */
export const __isLiveForTests = (roundId: number): boolean => live.has(roundId);

const readBusy = async (citizenid: string): Promise<{ id: number } | undefined> => {
  const [busy] = await Database.query<{ id: number }[]>(
    'SELECT `id` FROM `mica_casino_rounds` WHERE `active_crash` = ? LIMIT 1',
    [citizenid]
  );
  return busy;
};

app.registerEvent('crashStart', async (_source, _cbId, { stake }, citizenid, player) => {
  const { bet_min, bet_max } = betLimits();
  if (stake < bet_min) return refuse('below_min');
  if (stake > bet_max) return refuse('above_max');

  // The cheap answer, before any money moves. The unique key on `active_crash` is the real
  // guard: a second start racing past this read is refused by the insert and refunded.
  let busy = await readBusy(citizenid);
  if (busy && !live.has(busy.id)) {
    // A live row with no timer here can never be cashed out: a restart's leftover, or an insert
    // that answered late. Settle it if its time is up, and ask once more.
    try {
      await sweepStaleCrashRounds(citizenid);
    } catch (error) {
      console.error(`[casino] stale-round sweep for ${who(citizenid)} failed: ${reasonOf(error)}`);
    }
    busy = await readBusy(citizenid);
  }
  if (busy) return refuse('round_active');

  const refused = debit(player, stake);
  if (refused) return refuse(refused);

  const drawn = crashPointFor(drawUniform(), crashEdgePct());
  const instant = drawn === INSTANT_BUST;
  // An instant bust is recorded at 1.00×, already settled at payout 0, so no cash-out can ever
  // land on it and no timer is needed. It does not hold the `active_crash` key.
  const crashPoint = drawn ?? 100;
  const startedAt = Date.now();

  starting.set(citizenid, (starting.get(citizenid) ?? 0) + 1);
  try {
    let roundId = 0;
    let duplicate = false;
    try {
      roundId = await Database.insert(INSERT_ROUND, [
        citizenid,
        'crash',
        instant ? 'settled' : 'active',
        stake,
        0,
        null,
        crashPoint,
        JSON.stringify({ started_at: startedAt })
      ]);
    } catch (error) {
      duplicate = isDuplicateKey(error);
      if (!duplicate) {
        console.error(
          `[casino] crash round for ${who(citizenid)} could not be recorded: ${reasonOf(error)}`
        );
      }
    }
    if (!(roundId > 0)) {
      // An insert that timed out may still commit. Its row then has no timer here, and the
      // stale sweep settles it as lost once its time is up; the stake was refunded here.
      credit(player, stake, 'crash refund for an unrecorded round');
      return refuse(duplicate ? 'round_active' : 'round_failed');
    }

    if (instant) {
      // The reply says so, so the app can close the round from it. The push still goes out,
      // on the next turn, for an app that is listening rather than waiting on the reply.
      setTimeout(() => pushCrash(citizenid, roundId, crashPoint), 0);
      return { round_id: roundId, started_at: startedAt, busted: { crash_at: crashPoint } };
    }

    schedule(roundId, { citizenid, stake, startedAt, crashPoint });
    return { round_id: roundId, started_at: startedAt };
  } finally {
    const left = (starting.get(citizenid) ?? 1) - 1;
    if (left > 0) starting.set(citizenid, left);
    else starting.delete(citizenid);
  }
});

const BUSTED = (crashAt: number): CashoutReply => ({
  ok: false,
  reason: 'busted',
  crash_at: crashAt
});
const NOT_FOUND: CashoutReply = { ok: false, reason: 'not_found' };

interface CashoutRow {
  id: number;
  stake: number;
  payout: number;
  multiplier: number | null;
  status: string;
  crash_point: number;
}

const readOwnCrashRound = async (
  roundId: number,
  citizenid: string
): Promise<CashoutRow | null> => {
  const [row] = await Database.query<CashoutRow[]>(
    'SELECT `id`, `stake`, `payout`, `multiplier`, `status`, `crash_point` ' +
      'FROM `mica_casino_rounds` ' +
      "WHERE `id` = ? AND `citizenid` = ? AND `game` = 'crash' AND `status` <> 'deleted'",
    [roundId, citizenid]
  );
  return row ?? null;
};

/** A settled round's answer: a bust says where, a round already cashed out is not there. */
const settledReply = (row: CashoutRow): CashoutReply =>
  Number(row.payout) > 0 ? NOT_FOUND : BUSTED(Number(row.crash_point));

/**
 * Pay a cash-out the timer's settle overtook. The timer settled the row as lost while this
 * cash-out was reading it, but the cash-out was handled while the multiplier was still at or
 * below the point, and the handling moment is the one that counts. The row is settled lost and
 * unpaid (payout 0, no multiplier), so this second conditional write turns that bust into this
 * win, once. A round lost any other way has no start known here (`multiplier` is Infinity),
 * so it is never paid.
 */
const payLate = async (
  row: CashoutRow,
  multiplier: number,
  citizenid: string,
  player: FrameworkPlayer
): Promise<CashoutReply | null> => {
  if (row.status !== 'settled' || Number(row.payout) !== 0 || row.multiplier !== null) return null;
  if (!(multiplier <= Number(row.crash_point))) return null;

  const payout = Math.floor((Number(row.stake) * multiplier) / 100);
  const won = await Database.update(
    'UPDATE `mica_casino_rounds` SET `multiplier` = ?, `payout` = ? WHERE `id` = ? AND ' +
      "`citizenid` = ? AND `status` = 'settled' AND `payout` = 0 AND `multiplier` IS NULL " +
      'AND `crash_point` >= ?',
    [multiplier, payout, row.id, citizenid, multiplier]
  );
  if (!won) return null;

  forget(row.id);
  bustedByTimer.delete(row.id);
  credit(player, payout, `crash round ${row.id} cash-out at ${multiplier / 100}x`);
  return { ok: true, multiplier, payout };
};

app.registerEvent('crashCashout', async (_source, _cbId, { round_id }, citizenid, player) => {
  // The moment the request is handled is the moment that counts, before any read can wait.
  const now = Date.now();

  const row = await readOwnCrashRound(round_id, citizenid);
  if (!row) return NOT_FOUND;

  const crashAt = Number(row.crash_point);
  const startedAt = live.get(row.id)?.startedAt ?? bustedByTimer.get(row.id);
  // A round with no start known here started in an earlier process, or was refunded: it is
  // lost (the restart rule), and the stale sweep settles it if this does not.
  const multiplier =
    startedAt === undefined ? Number.POSITIVE_INFINITY : multiplierAt(now - startedAt);

  if (row.status !== 'active') {
    return (await payLate(row, multiplier, citizenid, player)) ?? settledReply(row);
  }

  // Ties go to the player: m equal to the point still wins.
  if (multiplier > crashAt) {
    if (await settleLost(row.id)) forget(row.id);
    return BUSTED(crashAt);
  }

  const payout = Math.floor((Number(row.stake) * multiplier) / 100);
  // Conditional on the row still being in play and on the point being at least this multiplier,
  // so a timer that settled first, a second cash-out, or a wrong clock cannot pay it twice.
  const won = await Database.update(
    "UPDATE `mica_casino_rounds` SET `status` = 'settled', `multiplier` = ?, `payout` = ? " +
      "WHERE `id` = ? AND `citizenid` = ? AND `status` = 'active' AND `crash_point` >= ?",
    [multiplier, payout, row.id, citizenid, multiplier]
  );
  if (!won) {
    const after = await readOwnCrashRound(row.id, citizenid);
    if (!after) return NOT_FOUND;
    if (after.status === 'active') return BUSTED(crashAt);
    return (await payLate(after, multiplier, citizenid, player)) ?? settledReply(after);
  }

  forget(row.id);
  credit(player, payout, `crash round ${row.id} cash-out at ${multiplier / 100}x`);
  return { ok: true, multiplier, payout };
});

app.registerEvent('crashState', async (_source, _cbId, _data, citizenid) => {
  const [row] = await Database.query<{ id: number; stake: number }[]>(
    'SELECT `id`, `stake` FROM `mica_casino_rounds` WHERE `active_crash` = ? LIMIT 1',
    [citizenid]
  );
  const round = row ? live.get(row.id) : undefined;
  // An active row with no timer here can never be cashed out and is about to be swept, so
  // there is nothing to pick back up.
  if (!row || !round) return null;
  return { round_id: row.id, stake: Number(row.stake), started_at: round.startedAt };
});

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

interface HistoryRow {
  id: number;
  game: 'roulette' | 'crash';
  status: 'active' | 'settled';
  stake: number;
  payout: number;
  multiplier: number | null;
  crash_point: number | null;
  result: string | null;
  created_at: Date | string;
}

const parseResult = (text: string | null): { number?: unknown; bets?: unknown } => {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const toCasinoRound = (row: HistoryRow): CasinoRound => {
  const result = row.game === 'roulette' ? parseResult(row.result) : {};
  return {
    id: row.id,
    game: row.game,
    status: row.status,
    stake: Number(row.stake),
    payout: Number(row.payout),
    multiplier: row.multiplier === null ? null : Number(row.multiplier),
    // The hidden outcome of a round in play is never handed out, the owner's own included.
    crash_point:
      row.status === 'active' || row.crash_point === null ? null : Number(row.crash_point),
    number: typeof result.number === 'number' ? result.number : null,
    bets: Array.isArray(result.bets) ? (result.bets as CasinoBet[]) : null,
    created_at: row.created_at
  };
};

app.registerEvent('history', async (_source, _cbId, data, citizenid) => {
  const { limit, cursor } = pageBounds(data, HISTORY_PAGING);
  const params: unknown[] = [citizenid];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<HistoryRow[]>(
    'SELECT `id`, `game`, `status`, `stake`, `payout`, `multiplier`, `crash_point`, `result`, ' +
      '`created_at` FROM `mica_casino_rounds` ' +
      "WHERE `citizenid` = ? AND `status` <> 'deleted'" +
      (cursor === null ? '' : ' AND `id` < ?') +
      ' ORDER BY `id` DESC LIMIT ?',
    params
  );

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map(toCasinoRound);
  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
});

// A phone in hand to stake money, server-side (MICA-339). Cash-out is not gated: the round
// was paid for with a phone in hand, and putting the phone away must not forfeit it.
app.requirePhoneFor('spin', 'crashStart');

/**
 * A player's privacy export reads every row they own. A live round's row carries its crash
 * point, so exporting it mid-round would hand out the outcome. Only settled rounds are exported.
 */
registerExportFilter(TABLE, () => ({ sql: "`status` <> 'active'", params: [] }));

// ---------------------------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------------------------

/** How often the stale sweep runs after the one at start. */
export const STALE_SWEEP_MS = 60_000;

interface StaleCandidate {
  id: number;
  citizenid: string;
  crash_point: number;
  result: string | null;
}

const startedAtIn = (result: string | null): number | null => {
  const startedAt = (parseResult(result) as { started_at?: unknown }).started_at;
  return typeof startedAt === 'number' ? startedAt : null;
};

/**
 * A live row that no timer here owns, with no start in flight for its citizen, and either begun
 * by an earlier process or past its crash time. It can never be cashed out (no start is known
 * for it), and until it settles it holds its owner's `active_crash` key.
 */
const isStale = (row: StaleCandidate, now: number): boolean => {
  if (live.has(row.id) || starting.has(row.citizenid)) return false;
  const startedAt = startedAtIn(row.result);
  if (startedAt === null || startedAt < BOOT_MS) return true;
  return startedAt + crashDelayMs(Number(row.crash_point)) <= now;
};

/**
 * Settle every stale Crash round as lost: at start, every `STALE_SWEEP_MS` after, and for one
 * citizen when their `crashStart` meets a live row with no timer.
 *
 * Three ways a row is left `active` with nothing to settle it:
 *
 * - **A restart mid-round.** A round's timer lives in this process's memory. The round is
 *   settled at its stored point with payout 0, and **the stake stays lost**: the server cannot
 *   know when the player would have cashed out, and refunding a round that may have been about
 *   to bust would make restarts a free option. The rule is the same for every round.
 * - **An insert that answered late.** `crashStart` refunded it as unrecorded, and it committed
 *   anyway. Settling it lost keeps the refund as the only money that moved.
 * - **A settle that kept failing**, which `onCrash` retries and this backs up.
 *
 * A round this process started is touched only once its crash time has passed, and never while
 * its timer exists or its citizen has a start in flight.
 */
export const sweepStaleCrashRounds = async (citizenid?: string): Promise<number> => {
  const rows = await Database.query<StaleCandidate[]>(
    citizenid === undefined
      ? 'SELECT `id`, `citizenid`, `crash_point`, `result` FROM `mica_casino_rounds` ' +
          'WHERE `active_crash` IS NOT NULL'
      : 'SELECT `id`, `citizenid`, `crash_point`, `result` FROM `mica_casino_rounds` ' +
          'WHERE `active_crash` = ?',
    citizenid === undefined ? [] : [citizenid]
  );
  const now = Date.now();
  const stale = rows.filter((row) => isStale(row, now)).map((row) => row.id);

  let settled = 0;
  for (const id of stale) {
    try {
      if (await settleLost(id)) settled += 1;
    } catch (error) {
      console.error(`[casino] could not settle stale crash round ${id}: ${reasonOf(error)}`);
    }
  }
  if (settled > 0) console.log(`[casino] settled ${settled} stale crash round(s) as lost.`);
  return settled;
};

let staleSweep: ReturnType<typeof setInterval> | undefined;

const sweepQuietly = (): void => {
  sweepStaleCrashRounds().catch((error: unknown) => {
    console.error(`[casino] the stale-round sweep failed: ${reasonOf(error)}`);
  });
};

/** Sweep now, then every `STALE_SWEEP_MS`. Idempotent. */
export const startStaleSweep = (): void => {
  if (staleSweep !== undefined) return;
  staleSweep = setInterval(sweepQuietly, STALE_SWEEP_MS);
  sweepQuietly();
};

/** The resource-start hook, exported so a test can drive it. */
export const onCasinoResourceStart = (resourceName: string): void => {
  if (resourceName !== GetCurrentResourceName()) return;
  whenSchemaReady(startStaleSweep);
};

on('onResourceStart', onCasinoResourceStart);
