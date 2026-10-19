// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import { assert, unique } from '../lib/mica';
import { eventually } from '../lib/wait';
import { schemaCreated } from './qbx';

/**
 * Casino (MICA-82, `server/services/Casino.ts`), as far as a server with nobody connected can
 * show it: the database's one-live-round-per-citizen key on a real MariaDB, and the stale-round
 * sweep settling a round no timer in this process owns, on the real runtime's interval.
 *
 * **What this cannot reach.** Every Casino action — `spin`, `crashStart`, `crashCashout`,
 * `crashState`, `history` — is a `mica:server:casino:*` net event behind `ServiceEndpoint`,
 * which authenticates through `FrameworkBridge.getPlayer(source)` and answers only by `emitNet`
 * to the source that asked. No client connects to this harness, so no handler runs and no reply
 * can be read. Standalone has no money either: its `FrameworkPlayer` answers `getMoney` with
 * `-Infinity` and refuses `removeMoney`/`addMoney`, so a spin or a stake would be refused
 * `insufficient_funds` even with a player. A round's timer, its `crash` push, a cash-out, an
 * instant bust and the hidden `crash_point` in `history`/`crashState` are all handler-side, and
 * `server/__tests__/casino.test.ts` is where they are held, against a scripted database.
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
  }
];
