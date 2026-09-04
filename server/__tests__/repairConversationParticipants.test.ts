// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0001_repair_conversation_participants';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
  // By default the live table looks like an existing install: old index there, new one not.
  dbMock.scalar.mockImplementation(async (_sql: string, params: unknown[]) =>
    params[1] === 'conversation_participant' ? 1 : 0
  );
});

/** Whitespace-insensitive, because the statements are written across many lines. */
const statements = () =>
  dbMock.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());

/**
 * The first versioned migration this repo has ever carried, so it is worth pinning what it
 * does rather than trusting that the machinery around it works. It repairs rows, not shape:
 * duplicate live participants written before `addParticipant` guarded against them, and the
 * `is_group` flags that a client used to be able to set (MICA-153).
 */
describe('0001_repair_conversation_participants', () => {
  it('is named for its file, which is what the ledger and the seed both key on', () => {
    expect(migration.id).toBe('0001_repair_conversation_participants');
  });

  it('removes duplicate participant rows before it counts anybody', async () => {
    await migration.up();

    const [dedup, recount] = statements();

    /**
     * The order is the correctness requirement, not a preference. A thread holding one
     * victim on 500 duplicate rows counts as 500 live participants, so recomputing first
     * would stamp `is_group = 1` on a genuine one-to-one and replace one wrong answer with
     * another.
     */
    expect(dedup).toContain('DELETE p FROM mica_messages_participants');
    expect(recount).toContain('UPDATE mica_messages_conversations');
    expect(recount).toContain('live_members');
  });

  /**
   * Soft-closing the surplus rows cannot work, and this is the assertion that says so.
   * `UNIQUE (conversation_id, citizenid)` carries no `left_at` component — deliberately —
   * so it counts rows rather than live rows, and 500 rows stamped `left_at` still collide.
   * A draft that stamped them failed the `ADD UNIQUE KEY` with ER 1062 against a real
   * MariaDB while every mocked assertion here passed.
   */
  it('deletes the surplus rows rather than closing them, or the unique key cannot go on', async () => {
    await migration.up();
    const [dedup] = statements();

    expect(dedup).toContain('GROUP BY conversation_id, citizenid');
    expect(dedup).toContain('p.id <> duplicated.keep_id');
    expect(dedup).not.toContain('SET p.left_at');
    expect(dedup).not.toContain("p.status = 'removed'");
  });

  /**
   * `removeParticipant` has no `LIMIT`, so a victim who leaves closes all 500 of their rows
   * at once — the ticket calls that an accidental mitigation. Those rows are then invisible
   * to a live-only filter and still violate the key, so the dedup must consider every row.
   */
  it('considers closed rows too, not only live ones', async () => {
    await migration.up();
    const [dedup] = statements();

    // The grouping subquery restricts nothing: no WHERE at all, so every row for a pair is
    // counted. `left_at` appears in it only inside the CASE that picks which row survives.
    const grouping = dedup.slice(dedup.indexOf('JOIN ('), dedup.indexOf(') duplicated'));
    expect(grouping).toContain('FROM mica_messages_participants GROUP BY');
    expect(grouping).not.toContain('WHERE');
  });

  it('keeps a live row over an older closed one, so nobody is dropped from a thread', async () => {
    await migration.up();
    const [dedup] = statements();

    // The earliest *live* row wins where one exists; the earliest row overall is only the
    // fallback, for a pair that has left entirely and whose history is worth keeping.
    expect(dedup).toContain('COALESCE( MIN(CASE WHEN left_at IS NULL THEN id END), MIN(id) )');
  });

  it('recomputes is_group from the live participant count', async () => {
    await migration.up();
    const [, recount] = statements();

    expect(recount).toContain('IF(live.live_members > 2, 1, 0)');
    // A repair must not reorder every player's thread list: `updated_at` is the sort key,
    // and naming it in SET is what suppresses ON UPDATE CURRENT_TIMESTAMP.
    expect(recount).toContain('c.updated_at = c.updated_at');
  });

  /**
   * The ledger stops a second run, but a migration that only works once because something
   * else remembers it is a migration that fails badly the first time that memory is wrong —
   * and `runMigrations` has an explicit path for "it ran but recording it failed", which
   * leaves an operator deciding whether to retry. Both statements are written so retrying is
   * a no-op.
   */
  it('is safe to run twice, because each statement matches nothing once it has run', async () => {
    await migration.up();
    const [dedup, recount] = statements();

    // Nothing is a duplicate any more, so the aggregate selects no group at all.
    expect(dedup).toContain('HAVING COUNT(*) > 1');
    // Every flag already agrees with the count, so the guard excludes every row.
    expect(recount).toContain('WHERE c.is_group <> IF(live.live_members > 2, 1, 0)');
  });

  it('stops at the first failure rather than counting a repair that did not happen', async () => {
    dbMock.query.mockRejectedValueOnce(new Error('deadlock'));

    await expect(migration.up()).rejects.toThrow('deadlock');
    // The recount never ran, so it cannot have counted un-deduplicated rows.
    expect(dbMock.query).toHaveBeenCalledTimes(1);
  });
});

/**
 * The index half. `SchemaMigrator`'s additive pass compares live indexes by name only and
 * never by uniqueness (`server/lib/migrate.ts`), so flipping `conversation_participant` to
 * unique in place would have been a silent no-op on every already-installed server — an
 * upgraded install permanently unlike a fresh one, with nothing reporting it. The migration
 * does the swap itself, under a new name.
 */
describe('0001_repair_conversation_participants — the unique key', () => {
  const ddl = () => statements().filter((sql) => sql.startsWith('ALTER TABLE'));

  /**
   * Add before drop, which is the failure-mode question rather than a style one. The
   * reverse order was tried against a real MariaDB: the `ADD` failed, and because the
   * `DROP` had already committed the table was left with no `(conversation_id, citizenid)`
   * index at all — slower than before the upgrade, still unprotected, and `micaschema
   * apply` aborted. This way a failure leaves the table exactly as it was found.
   */
  it('adds the unique key before dropping the old index', async () => {
    await migration.up();

    expect(ddl()).toEqual([
      'ALTER TABLE `mica_messages_participants` ADD UNIQUE KEY `conversation_participant_unique` (`conversation_id`, `citizenid`)',
      'ALTER TABLE `mica_messages_participants` DROP INDEX `conversation_participant`'
    ]);
  });

  it('leaves the old index in place when adding the unique key throws', async () => {
    dbMock.query.mockImplementation(async (sql: string) =>
      String(sql).includes('ADD UNIQUE KEY') ? Promise.reject(new Error('ER_DUP_ENTRY')) : []
    );

    await expect(migration.up()).rejects.toThrow('ER_DUP_ENTRY');
    expect(ddl()).not.toContain(
      'ALTER TABLE `mica_messages_participants` DROP INDEX `conversation_participant`'
    );
  });

  it('deduplicates before it adds the key, or the ALTER fails on a live server', async () => {
    await migration.up();

    const all = statements();
    const dedupAt = all.findIndex((sql) => sql.startsWith('DELETE p FROM'));
    const addAt = all.findIndex((sql) => sql.includes('ADD UNIQUE KEY'));

    expect(dedupAt).toBeGreaterThanOrEqual(0);
    expect(addAt).toBeGreaterThan(dedupAt);
  });

  it('asks information_schema before either DDL step, scoped to the current database', async () => {
    await migration.up();

    expect(dbMock.scalar).toHaveBeenCalledTimes(2);
    for (const [sql, params] of dbMock.scalar.mock.calls) {
      expect(String(sql).replace(/\s+/g, ' ')).toContain(
        'FROM information_schema.STATISTICS WHERE table_schema = DATABASE()'
      );
      expect(params[0]).toBe('mica_messages_participants');
    }
  });

  /**
   * The ledger normally stops a second run, but `runMigrations` has an explicit path for
   * "it ran and recording it failed", which leaves an operator deciding whether to retry.
   * A blind `ADD UNIQUE KEY` would error there and abort the rest of `micaschema apply`.
   */
  it('skips both DDL steps when the table already has the shape they produce', async () => {
    dbMock.scalar.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[1] === 'conversation_participant_unique' ? 1 : 0
    );

    await migration.up();

    expect(ddl()).toEqual([]);
    // The row repairs still run, and are themselves no-ops by then.
    expect(statements()).toHaveLength(2);
  });

  it('still adds the key on a table that never had the old index', async () => {
    dbMock.scalar.mockResolvedValue(0);

    await migration.up();

    expect(ddl()).toEqual([
      'ALTER TABLE `mica_messages_participants` ADD UNIQUE KEY `conversation_participant_unique` (`conversation_id`, `citizenid`)'
    ]);
  });
});
