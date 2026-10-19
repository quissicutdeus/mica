// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { call, seedPlayer, waitForPush, type PushEnvelope } from '../lib/door';
import { assert, unique } from '../lib/mica';
import { eventually } from '../lib/wait';
import { schemaCreated } from './qbx';

/**
 * Casino (MICA-82, `server/services/Casino.ts`) inside a real FXServer on a real MariaDB.
 *
 * The first two scenarios need no player: the database's one-live-round-per-citizen key, and the
 * stale-round sweep settling a round no timer in this process owns, on the real runtime's
 * interval.
 *
 * The rest drive the actions themselves — `spin`, `crashStart`, `crashCashout`, `crashState`,
 * `history`, `config` — through the integration door (MICA-397, `../lib/door.ts`), which runs
 * each action's own dispatch as a synthetic player whose bank is a ledger the door keeps. No
 * client connects to this harness and standalone has no money, so without the door none of this
 * is reachable. They run only in the standalone run, where `mica_phone_item` is unset: the door's
 * players hold no phone item, and `spin` and `crashStart` require one when it is set.
 *
 * The draw is random and stays random: no scenario touches the service. Where a scenario needs a
 * particular kind of round, it reads the stored point from the table (the ground truth, never
 * the subject) and chooses what to do with the round, or raises the edge convar the service
 * reads per call. A scenario whose draw can take more than one honest path asserts the path it
 * took and prints which, as a `[mica-integration]` line beside its PASS.
 */

const TABLE = 'mica_casino_rounds';

/** `Casino.ts`'s ceiling, ×100: a round at this point busts about 99.7 s after it starts. */
const POINT_MAX = 100_000;

/** The interval `sweepStaleCrashRounds` runs on after the one at start (`STALE_SWEEP_MS`). */
const SWEEP_EVERY_MS = 60_000;

/**
 * A Crash round as `crashStart` writes one, straight into the table: `result` carries the start
 * in server epoch ms, which is what the stale sweep reads (not `created_at`).
 */
const crashRow = async (
  citizenid: string,
  status: 'active' | 'settled',
  crashPoint: number,
  startedAt: number
): Promise<number> =>
  await db.insert(
    'INSERT INTO `mica_casino_rounds` ' +
      '(`citizenid`, `game`, `status`, `stake`, `payout`, `multiplier`, `crash_point`, `result`, ' +
      '`created_at`, `updated_at`) ' +
      "VALUES (?, 'crash', ?, 100, 0, NULL, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?))",
    [
      citizenid,
      status,
      crashPoint,
      JSON.stringify({ started_at: startedAt }),
      Math.floor(startedAt / 1000),
      Math.floor(startedAt / 1000)
    ]
  );

const roundOf = async (
  id: number
): Promise<{
  status: string;
  payout: number;
  multiplier: unknown;
  crash_point: number;
  active_crash: unknown;
} | null> => {
  const row = await db.row(
    'SELECT `status`, `payout`, `multiplier`, `crash_point`, `active_crash` ' +
      'FROM `mica_casino_rounds` WHERE `id` = ?',
    [id]
  );
  if (!row) return null;
  return {
    status: String(row.status),
    payout: Number(row.payout),
    multiplier: row.multiplier,
    crash_point: Number(row.crash_point),
    active_crash: row.active_crash
  };
};

const removeRounds = async (citizenids: readonly string[]): Promise<void> => {
  for (const citizenid of citizenids) {
    await db.exec(`DELETE FROM \`${TABLE}\` WHERE \`citizenid\` = ?`, [citizenid]);
  }
};

const isDuplicate = (error: unknown): boolean =>
  error instanceof Error && /Duplicate entry/i.test(error.message);

// ─── through the door (MICA-397) ─────────────────────────────────────────────────────────────

const CASINO = 'casino';

/** The edge convar `crashEdgePct` reads on every `crashStart`. */
const EDGE_CONVAR = 'mica_casino_crash_edge_pct';

/** Casino's replies, as `casinoContract` declares them. Restated, not imported. */
interface Refusal {
  ok: false;
  reason: string;
}
interface SpinReply {
  round_id: number;
  number: number;
  color: string;
  stake: number;
  payout: number;
}
interface StartReply {
  round_id: number;
  started_at: number;
  busted?: { crash_at: number };
}
type CashoutReply =
  | { ok: true; multiplier: number; payout: number }
  | { ok: false; reason: 'busted'; crash_at: number }
  | { ok: false; reason: 'not_found' };
interface ConfigReply {
  bet_min: number;
  bet_max: number;
  crash_edge_pct: number;
}
interface CrashState {
  round_id: number;
  stake: number;
  started_at: number;
}
interface HistoryRow {
  id: number;
  status: string;
  multiplier: number | null;
  crash_point: number | null;
}
interface Bet {
  kind: 'red' | 'straight';
  value?: number;
  amount: number;
}

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Which honest path a scenario's draw took, printed beside its PASS. */
const branch = (id: string, text: string): void => {
  console.log(`[mica-integration] ${id}: ${text}`);
};

/** A European wheel's reds, restated from `Casino.ts` so the paytable is checked, not echoed. */
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n: number): string => (n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black');

/** What `bets` return on `n`: a red pays 1:1, a straight 35:1, each with its stake back. */
const returnOn = (bets: readonly Bet[], n: number): number =>
  bets.reduce((sum, bet) => {
    if (bet.kind === 'red') return sum + (colorOf(n) === 'red' ? bet.amount * 2 : 0);
    return sum + (n === bet.value ? bet.amount * 36 : 0);
  }, 0);

/** `Casino.ts`'s `crashDelayMs`, restated: when the multiplier first passes `point`. */
const crashDelayMs = (point: number): number =>
  Math.max(0, Math.ceil(10_000 * Math.log2((point + 1) / 100)));

const isStart = (reply: unknown): reply is StartReply =>
  typeof (reply as StartReply | null)?.round_id === 'number' &&
  typeof (reply as StartReply).started_at === 'number';

const isRefusal = (reply: unknown, reason: string): boolean =>
  (reply as Refusal | null)?.ok === false && (reply as Refusal).reason === reason;

interface StoredRound {
  id: number;
  game: string;
  status: string;
  stake: number;
  payout: number;
  multiplier: number | null;
  crash_point: number | null;
  result: string | null;
  active_crash: unknown;
}

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const storedRound = async (id: number): Promise<StoredRound> => {
  const row = await db.row(
    'SELECT `id`, `game`, `status`, `stake`, `payout`, `multiplier`, `crash_point`, `result`, ' +
      '`active_crash` FROM `mica_casino_rounds` WHERE `id` = ?',
    [id]
  );
  if (!row) throw new Error(`round ${id} is not in mica_casino_rounds`);
  return {
    id: Number(row.id),
    game: String(row.game),
    status: String(row.status),
    stake: Number(row.stake),
    payout: Number(row.payout),
    multiplier: nullableNumber(row.multiplier),
    crash_point: nullableNumber(row.crash_point),
    result: typeof row.result === 'string' ? row.result : null,
    active_crash: row.active_crash
  };
};

/** A round the timer or an instant bust settled: lost, at its stored point, holding no key. */
const assertBust = (row: StoredRound, point: number, what: string): void => {
  assert(row.status === 'settled', `${what} is '${row.status}', not settled`);
  assert(row.payout === 0, `${what} paid ${row.payout}; a bust pays nothing`);
  assert(row.multiplier === null, `${what} has a cash-out multiplier ${row.multiplier}`);
  assert(row.crash_point === point, `${what}'s stored point is ${row.crash_point}, not ${point}`);
  assert(
    row.active_crash === null || row.active_crash === undefined,
    `${what} still holds its owner's active_crash key`
  );
};

const isCrashPushFor =
  (roundId: number) =>
  (envelope: PushEnvelope): boolean =>
    envelope.event === 'crash' && Number(envelope.payload?.round_id) === roundId;

/** Start one Crash round for `who`, failing on anything but a round, and check the debit. */
const startRound = async (
  who: string,
  stake: number,
  bankBefore: number
): Promise<{ reply: StartReply; bank: number }> => {
  const { result, bank } = await call<StartReply | Refusal>(CASINO, 'crashStart', who, { stake });
  assert(isStart(result), `crashStart answered ${show(result)}, not a round`);
  assert(
    bank === bankBefore - stake,
    `the bank is ${bank} after a ${stake} stake on ${bankBefore}; it moved other than once`
  );
  return { reply: result as StartReply, bank: bankBefore - stake };
};

const cashout = async (who: string, roundId: number) =>
  await call<CashoutReply>(CASINO, 'crashCashout', who, { round_id: roundId });

const history = async (who: string): Promise<HistoryRow[]> => {
  const { result } = await call<{ rows?: HistoryRow[] }>(CASINO, 'history', who, {});
  assert(Array.isArray(result?.rows), `history answered ${show(result)}`);
  return result.rows as HistoryRow[];
};

export const casinoScenarios: Scenario[] = [
  {
    // MICA-82: the first-start bootstrap made `active_crash`, the virtual column a unique key
    // holds, so the database itself refuses a second live Crash round for one citizen — the guard
    // `crashStart` relies on when two starts race past its read. A settled round holds nothing,
    // and another citizen's live round is not refused beside it.
    id: 'casino-active-crash-key-refuses-a-second-live-round',
    mode: 'standalone',
    tickets: ['MICA-82', 'MICA-396'],
    timeoutMs: 45_000,
    run: async (signal) => {
      await schemaCreated(signal);
      const player = unique('casino_key');
      const other = unique('casino_key_other');
      // Started now at the ceiling point, so the stale sweep, which may tick during this
      // scenario, leaves every active row here alone: it is neither from before boot nor past
      // its crash time.
      const now = Date.now();
      try {
        const live = await crashRow(player, 'active', POINT_MAX, now);
        const held = await roundOf(live);
        assert(
          held?.active_crash === player,
          `a live round's active_crash is ${JSON.stringify(held?.active_crash)}, not its citizen`
        );

        let refused: unknown = null;
        try {
          await crashRow(player, 'active', POINT_MAX, now);
        } catch (error) {
          refused = error;
        }
        assert(refused !== null, 'a second live Crash round for one citizen was written');
        assert(
          isDuplicate(refused),
          `the second live round failed for another reason: ${String(refused)}`
        );

        // Positive twins: the key is per citizen and per live round, not per table.
        const settled = await crashRow(player, 'settled', 250, now);
        const settledRow = await roundOf(settled);
        assert(
          settledRow?.active_crash === null || settledRow?.active_crash === undefined,
          `a settled round holds active_crash ${JSON.stringify(settledRow?.active_crash)}`
        );
        await crashRow(other, 'active', POINT_MAX, now);

        const rows = await db.count(`SELECT COUNT(*) FROM \`${TABLE}\` WHERE \`citizenid\` = ?`, [
          player
        ]);
        assert(rows === 2, `${rows} rounds for the citizen, not the live one and the settled one`);
      } finally {
        await removeRounds([player, other]);
      }
    }
  },
  {
    // MICA-82: a Crash round left `active` by an earlier process — a restart mid-round — has no
    // timer here and can never be cashed out. `sweepStaleCrashRounds`, on its interval, settles
    // it lost at its stored point with the stake kept, and frees its owner's live-round key; a
    // round this process could still be running is left in play beside it.
    id: 'casino-stale-sweep-settles-a-pre-boot-live-round-as-lost',
    mode: 'standalone',
    tickets: ['MICA-82', 'MICA-396'],
    // The sweep runs once at start and then every minute from when the schema was ready, so a
    // row planted now waits for the next tick: up to a minute, plus the slack below.
    timeoutMs: SWEEP_EVERY_MS + 25_000,
    run: async (signal) => {
      const tap = requireTap();
      await schemaCreated(signal);
      const restarted = unique('casino_stale');
      const playing = unique('casino_playing');
      const mark = tap.mark();
      try {
        // The round still in play is planted first, so any sweep that reads the stale one has
        // read this one too: a pass that left it active is a pass that judged it.
        const fresh = await crashRow(playing, 'active', POINT_MAX, Date.now());
        // Six hours ago: before this process booted, and long past a 1.50× point's crash time,
        // so it is stale on either of the sweep's two grounds.
        const stale = await crashRow(restarted, 'active', 150, Date.now() - 6 * 3_600_000);

        const after = await eventually(
          async () => {
            const row = await roundOf(stale);
            return row && row.status !== 'active' ? row : null;
          },
          SWEEP_EVERY_MS + 15_000,
          signal,
          'the stale-round sweep to settle a round from before boot'
        );
        assert(after.status === 'settled', `the stale round is '${after.status}', not settled`);
        assert(after.payout === 0, `the stale round paid ${after.payout}; the stake stays lost`);
        assert(
          after.multiplier === null || after.multiplier === undefined,
          `the stale round has a cash-out multiplier ${JSON.stringify(after.multiplier)}`
        );
        assert(
          after.crash_point === 150,
          `the stale round's crash point is ${after.crash_point}, not the stored 150`
        );
        assert(
          after.active_crash === null || after.active_crash === undefined,
          "the settled stale round still holds its owner's active_crash key"
        );

        await tap.waitFor(
          mark,
          /^\[casino\] settled \d+ stale crash round\(s\) as lost\.$/,
          5_000,
          signal,
          "the sweep's settled line"
        );

        const kept = await roundOf(fresh);
        assert(
          kept?.status === 'active',
          `a round started now at 1000× was swept to '${String(kept?.status)}'`
        );

        // The key is free again: the owner may hold a new live round.
        await crashRow(restarted, 'active', POINT_MAX, Date.now());
      } finally {
        await removeRounds([restarted, playing]);
      }
    }
  },
  {
    // MICA-82, MICA-397: a spin debits the whole stake, pays what the number it drew pays, and
    // records one settled roulette round carrying the number and the bets. A stake over the
    // table's limit is refused before any money moves and writes nothing.
    id: 'casino-roulette-spin-debits-pays-and-records',
    mode: 'standalone',
    tickets: ['MICA-82', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const who = unique('casino_spin');
      try {
        await seedPlayer(who, 1000);
        const bets: Bet[] = [
          { kind: 'red', amount: 100 },
          { kind: 'straight', value: 17, amount: 10 }
        ];
        const { result, bank } = await call<SpinReply | Refusal>(CASINO, 'spin', who, { bets });
        const spin = result as SpinReply;
        assert(
          Number.isInteger(spin?.round_id) && Number.isInteger(spin?.number),
          `spin answered ${show(result)}, not a round`
        );
        assert(spin.number >= 0 && spin.number <= 36, `the wheel drew ${spin.number}`);
        assert(
          spin.color === colorOf(spin.number),
          `${spin.number} came back ${spin.color}, not ${colorOf(spin.number)}`
        );
        assert(spin.stake === 110, `the spin staked ${spin.stake}, not 110`);
        const pays = returnOn(bets, spin.number);
        assert(spin.payout === pays, `${spin.number} paid ${spin.payout}, not ${pays}`);
        assert(
          bank === 1000 - 110 + pays,
          `the bank is ${bank} after a 110 stake paying ${pays} on 1000`
        );

        const ids = await db.rows('SELECT `id` FROM `mica_casino_rounds` WHERE `citizenid` = ?', [
          who
        ]);
        assert(ids.length === 1, `${ids.length} rounds recorded for one spin`);
        const row = await storedRound(spin.round_id);
        assert(Number(ids[0]?.id) === spin.round_id, 'the recorded round is not the one replied');
        assert(row.game === 'roulette', `the round is a '${row.game}' round`);
        assert(row.status === 'settled', `the spin's round is '${row.status}', not settled`);
        assert(row.stake === 110 && row.payout === pays, `the row holds ${show(row)}`);
        assert(
          row.multiplier === null && row.crash_point === null,
          `a roulette row holds a Crash multiplier or point: ${show(row)}`
        );
        const stored = JSON.parse(row.result ?? 'null') as { number?: unknown; bets?: unknown };
        assert(stored?.number === spin.number, `the row's result is ${row.result}`);
        const sent = bets.map((bet) => `${bet.kind}:${bet.value ?? ''}:${bet.amount}`).join(',');
        const kept = Array.isArray(stored.bets)
          ? (stored.bets as Bet[])
              .map((bet) => `${bet.kind}:${bet.value ?? ''}:${bet.amount}`)
              .join(',')
          : '';
        assert(kept === sent, `the row's bets are ${show(stored.bets)}, not the bets sent`);

        // The refusal, against a limit read from the server rather than assumed.
        const { result: limits } = await call<ConfigReply>(CASINO, 'config', who);
        const over = limits.bet_max + 1;
        const refused = await call<SpinReply | Refusal>(CASINO, 'spin', who, {
          bets: [{ kind: 'red', amount: over }]
        });
        assert(
          isRefusal(refused.result, 'above_max'),
          `a ${over} spin over the ${limits.bet_max} limit answered ${show(refused.result)}`
        );
        assert(
          refused.bank === bank,
          `a refused spin moved the bank from ${bank} to ${refused.bank}`
        );
        const after = await db.count(
          'SELECT COUNT(*) FROM `mica_casino_rounds` WHERE `citizenid` = ?',
          [who]
        );
        assert(after === 1, `a refused spin left ${after} rounds, not the one before it`);
      } finally {
        await removeRounds([who]);
      }
    }
  },
  {
    // MICA-82, MICA-397: a Crash round nobody cashes out is lost on the server's own timer, at
    // its stored point, no sooner than the multiplier passes it, and the owner is pushed `crash`
    // naming the round and the point. A cash-out after that answers the bust and pays nothing.
    //
    // Deterministic without touching the draw: each start's stored point is read from the
    // table, and a round above 2.00× (a bust up to ten seconds or more away) is cashed out at
    // once and another started. A point at or below 2.00× comes up on about 49% of starts, so
    // twelve starts find none about 0.03% of the time; then the scenario asserts the cash-out
    // path every one of them took instead, and prints that it did.
    id: 'casino-crash-busts-on-the-server-timer-and-pushes',
    mode: 'standalone',
    tickets: ['MICA-82', 'MICA-397'],
    // Twelve quick starts, then one bust at most ten seconds out, then the push's poll slack.
    timeoutMs: 40_000,
    run: async (signal) => {
      const id = 'casino-crash-busts-on-the-server-timer-and-pushes';
      await schemaCreated(signal);
      const who = unique('casino_timer');
      const LOW_POINT = 200;
      const STARTS = 12;
      try {
        let bank = (await seedPlayer(who, 1000)).bank;
        let chosen: { roundId: number; point: number; startedAt: number } | null = null;
        let lastCashedOut = 0;
        for (let attempt = 1; attempt <= STARTS && chosen === null; attempt += 1) {
          const started = await startRound(who, 10, bank);
          bank = started.bank;
          const roundId = started.reply.round_id;
          // An instant bust is settled in its reply and has no timer; the last scenario holds it.
          if (started.reply.busted) continue;
          const stored = (await storedRound(roundId)).crash_point;
          assert(stored !== null && stored >= 100, `round ${roundId} stored the point ${stored}`);
          const point = stored ?? 0;
          if (point <= LOW_POINT) {
            chosen = { roundId, point, startedAt: started.reply.started_at };
            break;
          }
          // Above 2.00×, an immediate cash-out lands on about 1.00× and cannot be past it.
          const out = await cashout(who, roundId);
          assert(out.result.ok === true, `an immediate cash-out answered ${show(out.result)}`);
          const paid = out.result.ok ? out.result.payout : 0;
          assert(out.bank === bank + paid, `a ${paid} cash-out took the bank to ${out.bank}`);
          bank = out.bank ?? bank;
          lastCashedOut = roundId;
        }

        if (chosen === null) {
          assert(lastCashedOut > 0, `${STARTS} starts were all instant busts`);
          const row = await storedRound(lastCashedOut);
          assert(
            row.status === 'settled' && row.payout >= 10 && (row.multiplier ?? 0) >= 100,
            `the last cashed-out round holds ${show(row)}`
          );
          branch(id, `cash-out branch: no point at or below 2.00x in ${STARTS} starts`);
          return;
        }

        const { roundId, point, startedAt } = chosen;
        const delay = crashDelayMs(point);
        const push = await waitForPush(
          who,
          isCrashPushFor(roundId),
          delay + 10_000,
          signal,
          `the crash push for round ${roundId} at ${point / 100}x`
        );
        assert(push.app === CASINO, `the crash push is for app '${push.app}'`);
        assert(
          Number(push.payload.crash_at) === point,
          `the push says crash_at ${show(push.payload.crash_at)}, not the stored ${point}`
        );
        // Node may fire a timer a millisecond early; five is slack, not a second.
        assert(
          push.at >= startedAt + delay - 5,
          `round ${roundId} at ${point / 100}x was pushed ${push.at - startedAt} ms after its ` +
            `start, before its ${delay} ms`
        );
        assertBust(await storedRound(roundId), point, `the timed-out round ${roundId}`);

        const late = await cashout(who, roundId);
        assert(
          isRefusal(late.result, 'busted') &&
            (late.result as { crash_at?: unknown }).crash_at === point,
          `a cash-out after the bust answered ${show(late.result)}`
        );
        assert(late.bank === bank, `a cash-out after the bust moved the bank to ${late.bank}`);
        branch(
          id,
          `bust branch: round ${roundId} at ${point / 100}x busted on the timer and was pushed ` +
            `${push.at - startedAt} ms after its start (due at ${delay} ms)`
        );
      } finally {
        await removeRounds([who]);
      }
    }
  },
  {
    // MICA-82, MICA-397: a cash-out pays once. The first, straight after the start, wins at the
    // multiplier the server's clock says and credits stake × multiplier; the second finds
    // nothing in play and moves nothing.
    //
    // The draw can take two other honest paths, each asserted and printed: an instant bust (3%
    // at the default edge), settled in the start's reply, every cash-out answered `busted`;
    // and a point of 1.00× whose 144 ms ran out before the cash-out arrived (under 1%), the
    // same.
    id: 'casino-cashout-pays-once-then-not-found',
    mode: 'standalone',
    tickets: ['MICA-82', 'MICA-397'],
    run: async (signal) => {
      const id = 'casino-cashout-pays-once-then-not-found';
      await schemaCreated(signal);
      const who = unique('casino_once');
      try {
        await seedPlayer(who, 1000);
        const started = await startRound(who, 100, 1000);
        const roundId = started.reply.round_id;

        const lostEveryTime = async (point: number, path: string): Promise<void> => {
          assertBust(await storedRound(roundId), point, `round ${roundId}`);
          for (const attempt of ['first', 'second']) {
            const out = await cashout(who, roundId);
            assert(
              isRefusal(out.result, 'busted') &&
                (out.result as { crash_at?: unknown }).crash_at === point,
              `the ${attempt} cash-out of a lost round answered ${show(out.result)}`
            );
            assert(out.bank === 900, `the ${attempt} cash-out of a lost round paid: ${out.bank}`);
          }
          branch(id, `${path} branch: round ${roundId} lost at ${point / 100}x; nothing paid`);
        };

        if (started.reply.busted) {
          assert(
            started.reply.busted.crash_at === 100,
            `an instant bust says crash_at ${started.reply.busted.crash_at}`
          );
          await lostEveryTime(100, 'instant-bust');
          return;
        }

        const first = await cashout(who, roundId);
        if (isRefusal(first.result, 'busted')) {
          // `lostEveryTime` holds the point it names to the one the table stored.
          const point = (first.result as { crash_at: number }).crash_at;
          await lostEveryTime(point, 'late-cash-out');
          return;
        }

        const won = first.result;
        assert(won.ok === true, `the first cash-out answered ${show(won)}`);
        if (!won.ok) return;
        assert(
          Number.isInteger(won.multiplier) && won.multiplier >= 100,
          `the cash-out multiplier is ${won.multiplier}`
        );
        assert(
          won.payout === Math.floor((100 * won.multiplier) / 100) && won.payout >= 100,
          `a 100 stake at ${won.multiplier / 100}x paid ${won.payout}`
        );
        assert(
          first.bank === 900 + won.payout,
          `the bank is ${first.bank} after a 100 stake and a ${won.payout} payout on 1000`
        );
        const row = await storedRound(roundId);
        assert(
          row.status === 'settled' &&
            row.payout === won.payout &&
            row.multiplier === won.multiplier &&
            (row.active_crash === null || row.active_crash === undefined),
          `the cashed-out round holds ${show(row)}`
        );

        const second = await cashout(who, roundId);
        assert(
          isRefusal(second.result, 'not_found'),
          `a second cash-out answered ${show(second.result)}`
        );
        assert(second.bank === first.bank, `a second cash-out moved the bank to ${second.bank}`);
        const again = await storedRound(roundId);
        assert(
          again.payout === won.payout,
          `a second cash-out changed the payout to ${again.payout}`
        );
      } finally {
        await removeRounds([who]);
      }
    }
  },
  {
    // MICA-82, MICA-397: the crash point is the outcome, and nothing hands it out while the
    // round is in play — not `crashState`, not the owner's own `history`. Its positive twin: the
    // table holds a point the whole time, and the same `history` shows it once the round settles.
    //
    // The reads count only if the round was still live after both, which the table says. A
    // round that busted first (an instant bust, or a point low enough to pass during the reads)
    // is let go and another started, up to five.
    id: 'casino-crash-point-hidden-while-live',
    mode: 'standalone',
    tickets: ['MICA-82', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const who = unique('casino_hidden');
      const STARTS = 5;
      try {
        let bank = (await seedPlayer(who, 1000)).bank;
        let proved = false;
        for (let attempt = 1; attempt <= STARTS && !proved; attempt += 1) {
          const started = await startRound(who, 10, bank);
          bank = started.bank;
          if (started.reply.busted) continue;
          const roundId = started.reply.round_id;

          const { result: state } = await call<CrashState | null>(CASINO, 'crashState', who);
          const listed = await history(who);
          const stored = await storedRound(roundId);
          if (stored.status !== 'active') continue;

          assert(stored.crash_point !== null, `the live round ${roundId} stores no point`);
          assert(
            state !== null &&
              state.round_id === roundId &&
              state.stake === 10 &&
              state.started_at === started.reply.started_at,
            `crashState for the live round ${roundId} answered ${show(state)}`
          );
          assert(
            !show(state).includes('crash_point'),
            `crashState hands out the point: ${show(state)}`
          );
          const live = listed.find((row) => row.id === roundId);
          assert(live, `history does not list the live round ${roundId}: ${show(listed)}`);
          assert(live?.status === 'active', `history lists the live round as '${live?.status}'`);
          assert(
            live?.crash_point === null,
            `history hands out the live round's point: ${show(live)}`
          );
          for (const row of listed) {
            assert(
              row.status !== 'active' || row.crash_point === null,
              `history hands out a live round's point: ${show(row)}`
            );
          }

          const out = await cashout(who, roundId);
          assert(
            out.result.ok === true || isRefusal(out.result, 'busted'),
            `cashing the live round out answered ${show(out.result)}`
          );
          bank = out.bank ?? bank;
          const settled = (await history(who)).find((row) => row.id === roundId);
          assert(
            settled?.status === 'settled' && settled.crash_point === stored.crash_point,
            `once settled, history shows ${show(settled)}, not the stored ${stored.crash_point}`
          );
          proved = true;
        }
        assert(proved, `no round stayed live through crashState and history in ${STARTS} starts`);
      } finally {
        await removeRounds([who]);
      }
    }
  },
  {
    // MICA-82, MICA-397: an instant bust — a draw below 1.00× — is settled in `crashStart`'s own
    // reply: the stake taken, the round recorded lost at 1.00× holding no live-round key, the
    // `crash` push sent with `crash_at: 100`, and a cash-out after it paying nothing.
    //
    // The edge convar is raised to 20 for the scenario (the service reads it on every start, and
    // `config` confirms micaOS saw it), so a start busts instantly one time in five, and fifty
    // starts find none with probability 0.8^50, about 1.4e-5. At the default 3% the two hundred
    // starts that would make it as rare cannot run: the limiter allows 60 of one action a minute.
    id: 'casino-instant-bust-is-settled-in-the-reply',
    mode: 'standalone',
    tickets: ['MICA-82', 'MICA-397'],
    run: async (signal) => {
      const id = 'casino-instant-bust-is-settled-in-the-reply';
      await schemaCreated(signal);
      const who = unique('casino_instant');
      const STARTS = 50;
      // Unset reads as '' here, and '' is what Casino reads as unset too: it parses to no number,
      // so the default edge applies, exactly as before the scenario.
      const previous = GetConvar(EDGE_CONVAR, '');
      SetConvar(EDGE_CONVAR, '20');
      try {
        let bank = (await seedPlayer(who, 10_000)).bank;
        const { result: config } = await call<ConfigReply>(CASINO, 'config', who);
        assert(
          config?.crash_edge_pct === 20,
          `micaOS reads the Crash edge as ${show(config?.crash_edge_pct)} after it was set to 20`
        );

        let bust: StartReply | null = null;
        let starts = 0;
        while (bust === null && starts < STARTS) {
          starts += 1;
          const started = await startRound(who, 10, bank);
          bank = started.bank;
          if (started.reply.busted) {
            bust = started.reply;
            break;
          }
          // Free the live-round key for the next start. A point of about 1.00× may already be
          // past; either answer settles the round.
          const out = await cashout(who, started.reply.round_id);
          assert(
            out.result.ok === true || isRefusal(out.result, 'busted'),
            `a cash-out between starts answered ${show(out.result)}`
          );
          bank = out.bank ?? bank;
        }
        assert(bust !== null, `no instant bust in ${STARTS} starts at a 20% edge`);
        if (bust === null) return;

        assert(bust.busted?.crash_at === 100, `the instant bust says ${show(bust.busted)}`);
        assertBust(await storedRound(bust.round_id), 100, `the instant bust ${bust.round_id}`);

        const push = await waitForPush(
          who,
          isCrashPushFor(bust.round_id),
          5_000,
          signal,
          `the crash push for the instant bust ${bust.round_id}`
        );
        assert(push.app === CASINO, `the crash push is for app '${push.app}'`);
        assert(
          Number(push.payload.crash_at) === 100,
          `the instant bust's push says crash_at ${show(push.payload.crash_at)}`
        );

        const late = await cashout(who, bust.round_id);
        assert(
          isRefusal(late.result, 'busted') &&
            (late.result as { crash_at?: unknown }).crash_at === 100,
          `a cash-out of the instant bust answered ${show(late.result)}`
        );
        assert(late.bank === bank, `a cash-out of the instant bust moved the bank to ${late.bank}`);

        // The bust holds no key: nothing is in play, and a new round starts.
        const { result: state } = await call<CrashState | null>(CASINO, 'crashState', who);
        assert(state === null, `crashState after an instant bust answered ${show(state)}`);
        const next = await startRound(who, 10, bank);
        if (!next.reply.busted) await cashout(who, next.reply.round_id);
        branch(id, `instant bust on start ${starts} of at most ${STARTS}, at a 20% edge`);
      } finally {
        SetConvar(EDGE_CONVAR, previous);
        await removeRounds([who]);
      }
    }
  }
];
