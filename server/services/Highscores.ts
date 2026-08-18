import { defineService, SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { fields } from '../lib/payload';
import { resolve as resolveDirectory } from '../lib/PlayerDirectory';
import type { Highscore, LeaderboardEntry } from '@shared/types';

/**
 * Every game (or scoreboard-shaped app) this table serves. Extend when the next one ships —
 * `app` is interpolated into no SQL, but it is still checked so a typo doesn't silently create
 * a new, permanent leaderboard nobody meant to make.
 */
const KNOWN_APPS = ['snek'] as const;
type KnownApp = (typeof KNOWN_APPS)[number];
const isKnownApp = (value: unknown): value is KnownApp =>
  typeof value === 'string' && (KNOWN_APPS as readonly string[]).includes(value);

/** Above this, a score is not a play session, it's a bug or a modified client. */
const MAX_PLAUSIBLE_SCORE = 1_000_000;

function requireScore(raw: unknown): number {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new Error('A valid score is required.');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PLAUSIBLE_SCORE) {
    throw new Error('A valid score is required.');
  }
  return value;
}

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
export const highscores = defineService<Highscore>({
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
  const body = fields(data);
  if (!isKnownApp(body.app)) {
    throw new Error('Unknown game.');
  }
  const score = requireScore(body.score);

  await repo.upsertBest(citizenid, body.app, score);
  return { ok: true };
});

/** Top 10 for a game, with names resolved server-side — never trust a client-supplied name. */
app.registerEvent('top', async (source, cbId, data) => {
  const body = fields(data);
  if (!isKnownApp(body.app)) {
    throw new Error('Unknown game.');
  }

  const rows = await repo.top(body.app, 10);
  const entries: LeaderboardEntry[] = await Promise.all(
    rows.map(async (row) => {
      const directory = await resolveDirectory(row.citizenid);
      return {
        citizenid: row.citizenid,
        score: row.score,
        displayName: directory?.displayName ?? null
      };
    })
  );
  return entries;
});
