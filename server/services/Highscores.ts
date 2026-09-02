// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService, SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { highscoresContract } from '@gphone/shared/contracts/highscores';
import { resolveMany } from '../lib/PlayerDirectory';
import type { Highscore, LeaderboardEntry } from '@gphone/shared/types';

/**
 * Every game (or scoreboard-shaped app) this table serves. Extend when the next one ships —
 * `app` is interpolated into no SQL, but it is still checked so a typo doesn't silently create
 * a new, permanent leaderboard nobody meant to make.
 */
const KNOWN_APPS = ['snek'] as const;
type KnownApp = (typeof KNOWN_APPS)[number];
const isKnownApp = (value: unknown): value is KnownApp =>
  typeof value === 'string' && (KNOWN_APPS as readonly string[]).includes(value);

/**
 * Above a million a score is not a play session, it's a bug or a modified client. The bound is
 * declared in `shared/contracts/highscores.ts` and enforced before either handler runs.
 */

class HighscoreRepository extends SchemaRepository<Highscore> {
  /**
   * Insert this player's score, or raise their existing row only if the new score is
   * higher. `GREATEST` rather than a read-then-write, because a read-then-write has a race
   * two concurrent submissions from the same player would lose.
   */
  async upsertBest(citizenid: string, app: string, score: number): Promise<void> {
    await Database.query(
      `INSERT INTO \`${this.tableName}\` (citizenid, app, score)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE score = GREATEST(score, VALUES(score))`,
      [citizenid, app, score]
    );
  }

  async top(app: string, limit: number): Promise<Array<{ citizenid: string; score: number }>> {
    return await Database.query<Array<{ citizenid: string; score: number }>>(
      `SELECT citizenid, score FROM \`${this.tableName}\`
       WHERE app = ? AND status = 'active'
       ORDER BY score DESC
       LIMIT ?`,
      [app, limit]
    );
  }
}

/**
 * Shared highscore table for every game in the phone, discriminated by `app` — the same
 * "one table, an `app` column" shape as `gphone_accounts`, so a second game reuses this
 * instead of shipping its own table and migration.
 *
 * Generic get/create/update/delete are all off: writes go through `submit`'s upsert-if-higher
 * rule, and reads go through `top`'s ordered, name-resolved projection. Neither is something the
 * generic paths can express.
 */
export const highscores = defineService<Highscore, typeof highscoresContract>({
  contract: highscoresContract,
  id: 'highscores',
  access: { read: 'owner', write: 'owner' },
  schema: {
    app: { type: 'string', length: 32, notNull: true, clientWritable: false },
    score: { type: 'int', notNull: true, clientWritable: false }
  },
  indexes: [{ name: 'citizenid_app', columns: ['citizenid', 'app'], unique: true }],
  options: {
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  },
  repositoryFactory: (resolved: ResolvedService) => new HighscoreRepository(resolved)
});

const app = highscores.app;
const repo = highscores.repo as HighscoreRepository;

/** Submit a run's score. Only ever raises the caller's own stored best. */
app.registerEvent('submit', async (source, cbId, data, citizenid) => {
  // The contract bounds `app`'s shape; this is what says which games exist. The list names an
  // app the Store installs, so it cannot live in `shared/` — see the contract's own note.
  if (!isKnownApp(data.app)) {
    throw new PlayerFacingError('Unknown game.', { key: 'server.highscores.unknownGame' });
  }

  await repo.upsertBest(citizenid, data.app, data.score);
  return { ok: true };
});

/**
 * Top 10 for a game, with names resolved server-side — never trust a client-supplied name.
 *
 * The names come back in **one** lookup. This used to `Promise.all` a `resolve` per row, and
 * `resolve` is a `LIMIT 1` query for anybody not currently connected — so a leaderboard of ten
 * offline players was eleven round trips to render ten rows (MICA-197). `resolveMany` asks
 * the same question of the same table once, and answers the connected players from the
 * framework without asking at all.
 *
 * A citizenid the framework has no record of keeps its `null` name rather than being dropped:
 * the score is real and belongs on the board whether or not the character still exists.
 */
app.registerEvent('top', async (source, cbId, data) => {
  if (!isKnownApp(data.app)) {
    throw new PlayerFacingError('Unknown game.', { key: 'server.highscores.unknownGame' });
  }

  const rows = await repo.top(data.app, 10);
  const directory = await resolveMany(rows.map((row) => row.citizenid));

  const entries: LeaderboardEntry[] = rows.map((row) => ({
    citizenid: row.citizenid,
    score: row.score,
    displayName: directory.get(row.citizenid)?.displayName ?? null
  }));
  return entries;
});
