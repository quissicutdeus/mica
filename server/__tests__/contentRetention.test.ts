// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-167: age-based retention for messages, DMs and media.
 *
 * `Database` is a stub, so nothing here evaluates the pruning SQL itself. A small fake answers
 * the bookkeeping — `information_schema` and the grace markers in the migrations ledger — and
 * the pruned table serves ids in batches. What the suite proves: which convar each table reads
 * and what it falls back to; that no statement against a pruned table names more than a batch;
 * that every hold is in *both* the select and the update; that nothing is deleted — an expired
 * row moves to `expired` and its children stay (MICA-428); the grace, the index gate and the
 * schedule. That MariaDB and MySQL accept these
 * statements and keep the right rows was checked against real `mariadb:11` and `mysql:8`
 * containers during MICA-167; `pnpm test:schema` does not execute them.
 */
const { dbMock, startHandlers } = vi.hoisted(() => {
  const starts: Function[] = [];
  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    if (event === 'onResourceStart') starts.push(handler);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    startHandlers: starts
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => null,
    getSourceByCitizenId: () => null,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {},
    ownerTable: () => ({ table: 'players', column: 'citizenid' })
  }
}));

import {
  RETENTION_BATCH,
  RETENTION_GRACE_MS,
  RETENTION_INTERVAL_MS,
  RETENTION_MAX_BATCHES,
  holdClause,
  isRetentionRunning,
  liveReferences,
  onRetentionResourceStart,
  parseRetentionDays,
  pruneTable,
  registerRetention,
  resetRetentionForTests,
  retentionMarkerId,
  retentionPolicies,
  runRetention,
  type RetentionPolicy
} from '../lib/contentRetention';
import { __setSchemaReadyForTests } from '../lib/schemaReady';
import '../services/Media';
import '../services/Messages';
import '../services/DirectMessages';
import '../services/Marketplace';
import '../services/Blabber';

const policy = (table: string): RetentionPolicy => {
  const found = retentionPolicies().find((p) => p.table === table);
  if (!found) throw new Error(`no retention policy for ${table}`);
  return found;
};

const withConvar = (values: Record<string, string>) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in values ? values[name] : fallback;
};

const flat = (sql: unknown): string => String(sql).replace(/\s+/g, ' ');
const calls = () =>
  dbMock.query.mock.calls.map((c) => ({ sql: flat(c[0]), params: (c[1] ?? []) as unknown[] }));
const DAY_S = 24 * 60 * 60;

/**
 * The database's bookkeeping: whether the ledger exists, which tables lack their index, and
 * the grace markers with their ages in seconds.
 */
const db = {
  ledger: true,
  unindexed: new Set<string>(),
  markers: new Map<string, number>(),
  count: 0
};

/** Every table's grace long over, for a 1-day window, which covers any longer one. */
const graceOver = () => {
  for (const p of retentionPolicies()) db.markers.set(retentionMarkerId(p.table, 1), 2 * DAY_S);
};

/** MySQL's `LIKE` with no escape character: `%` any run, `_` any one character. */
const like = (pattern: string) =>
  new RegExp(
    '^' +
      pattern
        .split('')
        .map((c) => (c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      '$'
  );

/** Answer a bookkeeping statement, or `undefined` for anything else. */
const bookkeeping = (text: string, params: unknown[]): unknown => {
  if (text.includes('information_schema.TABLES')) return [{ n: db.ledger ? 1 : 0 }];
  if (text.includes('information_schema.STATISTICS')) {
    return [{ n: db.unindexed.has(String(params[0])) ? 0 : 1 }];
  }
  if (text.startsWith('SELECT m.`id` AS `id`, TIMESTAMPDIFF')) {
    // A marker announced before the table's off marker is void (MICA-428): older is a larger age.
    const pattern = like(String(params[0]));
    const off = db.markers.get(String(params[1]));
    return [...db.markers]
      .filter(([id, age]) => pattern.test(id) && (off === undefined || off >= age))
      .map(([id, age]) => ({ id, age }));
  }
  if (
    text.startsWith('INSERT INTO `mica_schema_migrations` (`id`) VALUES (?) ON DUPLICATE KEY') &&
    text.endsWith('UPDATE `applied_at` = CURRENT_TIMESTAMP')
  ) {
    db.markers.set(String(params[0]), 0);
    return { affectedRows: 1 };
  }
  if (text.startsWith('SELECT COUNT(*) AS `n` FROM `mica_')) return [{ n: db.count }];
  return undefined;
};

/**
 * `table` holds `total` expired rows. Each select serves the next batch of ids, capped at the
 * LIMIT it was asked for; each update moves exactly the ids it named.
 */
const expired = (table: string, total: number) => {
  let next = 1;
  db.count = total;
  dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = flat(sql);
    const answer = bookkeeping(text, params);
    if (answer !== undefined) return answer;
    if (text.startsWith(`SELECT t.\`id\` FROM \`${table}\``)) {
      const limit = Number(/LIMIT (\d+)$/.exec(text)?.[1] ?? 0);
      const ids: { id: number }[] = [];
      while (ids.length < limit && next <= total) ids.push({ id: next++ });
      return ids;
    }
    if (text.startsWith(`UPDATE \`${table}\` SET \`status\` = ?`)) {
      const marks = /IN \(([?, ]+)\)/.exec(text)![1].split(',').length;
      return { affectedRows: marks };
    }
    return text.startsWith('SELECT') ? [] : { affectedRows: 0 };
  });
};

const selects = (table?: string) =>
  calls().filter((c) => c.sql.startsWith(`SELECT t.\`id\` FROM \`${table ?? ''}`));
const expiresOf = (table: string) => calls().filter((c) => c.sql.startsWith(`UPDATE \`${table}\``));

beforeEach(() => {
  vi.clearAllMocks();
  // The start hook waits for the first-start schema check (MICA-306); settle it as an
  // existing database, so the schedule starts without the check's own queries.
  __setSchemaReadyForTests({ kind: 'existing' });
  dbMock.query.mockReset();
  db.ledger = true;
  db.unindexed.clear();
  db.markers.clear();
  db.count = 0;
  graceOver();
  dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const answer = bookkeeping(flat(sql), params);
    return answer !== undefined ? answer : [];
  });
  withConvar({});
  resetRetentionForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  resetRetentionForTests();
});

describe('parseRetentionDays', () => {
  it('uses the default when the convar is unset or empty', () => {
    expect(parseRetentionDays('', 180, 'x')).toBe(180);
    expect(parseRetentionDays('   ', 180, 'x')).toBe(180);
    expect(parseRetentionDays(undefined, 180, 'x')).toBe(180);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('is off at 0 or off, the explicit keep-forever', () => {
    expect(parseRetentionDays('0', 180, 'x')).toBe(0);
    expect(parseRetentionDays('OFF', 180, 'x')).toBe(0);
  });

  it('takes a positive whole number of days', () => {
    expect(parseRetentionDays('45', 180, 'x')).toBe(45);
    expect(parseRetentionDays(' 7 ', 180, 'x')).toBe(7);
  });

  it('lands a value it cannot read on the default, never on forever, and says so', () => {
    for (const raw of ['-5', 'abc', '1.5', '30days', '99999999999999999999']) {
      expect(parseRetentionDays(raw, 180, 'mica_message_retention')).toBe(180);
    }
    expect(console.warn).toHaveBeenCalledTimes(5);
    expect(String((console.warn as any).mock.calls[0][0])).toContain('mica_message_retention');
  });
});

describe('each table reads its own convar', () => {
  const cases = [
    { table: 'mica_messages', convar: 'mica_message_retention', fallback: 180 },
    { table: 'mica_blabber_dms', convar: 'mica_dm_retention', fallback: 90 },
    { table: 'mica_media', convar: 'mica_media_retention', fallback: 365 }
  ];

  for (const { table, convar, fallback } of cases) {
    it(`${table}: ${convar}, default ${fallback}, 0 off, garbage → default`, () => {
      expect(policy(table).convar).toBe(convar);
      expect(policy(table).days()).toBe(fallback);
      withConvar({ [convar]: '12' });
      expect(policy(table).days()).toBe(12);
      withConvar({ [convar]: '0' });
      expect(policy(table).days()).toBe(0);
      withConvar({ [convar]: 'soon' });
      expect(policy(table).days()).toBe(fallback);
    });
  }

  it('does not let one table’s convar move another’s window', () => {
    withConvar({ mica_message_retention: '3' });
    expect(policy('mica_blabber_dms').days()).toBe(90);
    expect(policy('mica_media').days()).toBe(365);
  });

  it('prunes against the window the convar resolved to, on the database clock', async () => {
    withConvar({ mica_dm_retention: '10' });
    expired('mica_blabber_dms', 1);

    await pruneTable(policy('mica_blabber_dms'));

    const select = selects('mica_blabber_dms')[0];
    expect(select.sql).toContain('t.`created_at` < NOW() - INTERVAL ? DAY');
    expect(select.params[0]).toBe(10);
    const remove = expiresOf('mica_blabber_dms')[0];
    expect(remove.sql).toContain('`created_at` < NOW() - INTERVAL ? DAY');
    expect(remove.params[2]).toBe(10);
  });

  it('expires only active rows, to expired, and keeps updated_at (MICA-428)', async () => {
    expired('mica_messages', 2);

    await pruneTable(policy('mica_messages'));

    const select = selects('mica_messages')[0];
    expect(select.sql).toContain("WHERE t.`status` = 'active' AND t.`created_at` <");
    const update = expiresOf('mica_messages')[0];
    expect(update.sql).toMatch(
      /^UPDATE `mica_messages` SET `status` = \?, `updated_at` = `updated_at` WHERE `id` IN \(\?, \?\) AND `status` = 'active' AND /
    );
    expect(update.params.slice(0, 3)).toEqual(['expired', 1, 2]);
  });

  it('hides nothing in the table while it is off', async () => {
    withConvar({ mica_message_retention: '0' });
    expired('mica_messages', 5);

    expect(await pruneTable(policy('mica_messages'))).toBe(0);
    expect(selects()).toEqual([]);
    expect(expiresOf('mica_messages')).toEqual([]);
  });
});

describe('batching', () => {
  it('never names more than a batch of rows in a statement against the pruned table', async () => {
    vi.useFakeTimers();
    expired('mica_messages', RETENTION_BATCH * 2 + 3);

    const run = pruneTable(policy('mica_messages'));
    await vi.runAllTimersAsync();

    expect(await run).toBe(RETENTION_BATCH * 2 + 3);
    const onTable = [...selects('mica_messages'), ...expiresOf('mica_messages')];
    expect(selects('mica_messages')).toHaveLength(3);
    expect(expiresOf('mica_messages')).toHaveLength(3);
    for (const statement of onTable) {
      expect(statement.sql).toMatch(new RegExp(`LIMIT ${RETENTION_BATCH}$`));
    }
    for (const statement of expiresOf('mica_messages')) {
      const ids = /IN \(([?, ]+)\)/.exec(statement.sql)![1].split(',').length;
      expect(ids).toBeLessThanOrEqual(RETENTION_BATCH);
    }
  });

  it('yields between full batches rather than running them back to back', async () => {
    vi.useFakeTimers();
    expired('mica_messages', RETENTION_BATCH + 1);

    const run = pruneTable(policy('mica_messages'));
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(selects('mica_messages')).toHaveLength(1);

    await vi.runAllTimersAsync();
    await run;
    expect(selects('mica_messages')).toHaveLength(2);
  });

  it('stops at the per-run cap and leaves the rest for the next run', async () => {
    vi.useFakeTimers();
    expired('mica_messages', Number.MAX_SAFE_INTEGER);

    const run = pruneTable(policy('mica_messages'));
    await vi.runAllTimersAsync();

    expect(await run).toBe(RETENTION_BATCH * RETENTION_MAX_BATCHES);
    expect(console.warn).toHaveBeenCalled();
  });

  it('leaves its own children as they are, and deletes nothing anywhere (MICA-428)', async () => {
    for (const table of ['mica_messages', 'mica_blabber_dms', 'mica_media']) {
      dbMock.query.mockClear();
      expired(table, 2);

      await pruneTable(policy(table));

      expect(calls().some((c) => /DELETE/.test(c.sql))).toBe(false);
      const writes = calls().filter((c) => /^(UPDATE|INSERT)/.test(c.sql));
      expect(writes.map((c) => /^(?:UPDATE|INSERT INTO) `(\w+)`/.exec(c.sql)![1])).toEqual([table]);
    }
  });
});

describe('holds', () => {
  const OPEN = "r.`status` = 'active' AND r.`resolution` = 'pending'";

  /** The select and the update for one prune of `table`, with the hold SQL each carried. */
  const bothStatements = async (table: string) => {
    expired(table, 1);
    await pruneTable(policy(table));
    return { select: selects(table)[0], remove: expiresOf(table)[0] };
  };

  it('an open report on the row itself, in the select and again in the update', async () => {
    const { select, remove } = await bothStatements('mica_messages');

    expect(select.sql).toContain(
      'NOT EXISTS (SELECT 1 FROM `mica_reports` r WHERE r.`target_table` = ? AND r.`target_id` = t.`id`'
    );
    expect(remove.sql).toContain('r.`target_id` = `mica_messages`.`id`');
    expect(select.sql).toContain(OPEN);
    expect(remove.sql).toContain(OPEN);
    expect(select.params).toContain('mica_messages');
  });

  /**
   * MICA-426: once its report is actioned, the open-report hold no longer names a moderated row,
   * and every prune took it at its age — so a reopen found nothing to put back. The row's own
   * status holds it, in every retained table, in the select and again in the update.
   */
  it.each(['mica_messages', 'mica_blabber_dms', 'mica_media'])(
    '%s: a moderated row is held, in the select and again in the update',
    async (table) => {
      const { select, remove } = await bothStatements(table);

      expect(select.sql).toContain(`AND ${OPEN}) AND t.\`status\` <> 'moderated'`);
      expect(remove.sql).toContain(`AND ${OPEN}) AND \`${table}\`.\`status\` <> 'moderated'`);
      // A row its author deleted stays `deleted`: only an `active` one expires (MICA-428).
      for (const statement of [select, remove]) {
        expect(statement.sql).not.toMatch(/`status` (=|<>|!=) 'deleted'/);
        expect(statement.sql).toMatch(/`status` = 'active'/);
      }
    }
  );

  it('messages: an open report on any message holds its whole conversation', async () => {
    const { select, remove } = await bothStatements('mica_messages');

    for (const [statement, row] of [
      [select, 't'],
      [remove, '`mica_messages`']
    ] as const) {
      expect(statement.sql).toContain(
        'NOT (EXISTS (SELECT 1 FROM (SELECT DISTINCT m.`conversation_id` AS `k` FROM `mica_reports` r ' +
          'JOIN `mica_messages` m ON m.`id` = r.`target_id`'
      );
      expect(statement.sql).toContain(`WHERE held.\`k\` = ${row}.\`conversation_id\`))`);
    }
  });

  it('DMs: an open report on an account holds every DM it sent or received', async () => {
    const { select, remove } = await bothStatements('mica_blabber_dms');

    expect(select.sql).toContain(
      'r.`target_table` = ? AND r.`target_id` IN (t.`from_account`, t.`to_account`)'
    );
    expect(remove.sql).toContain(
      'r.`target_id` IN (`mica_blabber_dms`.`from_account`, `mica_blabber_dms`.`to_account`)'
    );
    expect(select.params).toContain('mica_accounts');
  });

  it('DMs: an open report on one DM holds the whole thread, both directions', async () => {
    const { select, remove } = await bothStatements('mica_blabber_dms');

    for (const [statement, row] of [
      [select, 't'],
      [remove, '`mica_blabber_dms`']
    ] as const) {
      expect(statement.sql).toContain(
        'SELECT DISTINCT d.`from_account` AS `a`, d.`to_account` AS `b`'
      );
      expect(statement.sql).toContain(
        `(held.\`a\` = ${row}.\`from_account\` AND held.\`b\` = ${row}.\`to_account\`) ` +
          `OR (held.\`a\` = ${row}.\`to_account\` AND held.\`b\` = ${row}.\`from_account\`)`
      );
    }
  });

  it('binds the parameters in the order the SQL names them, in both statements', async () => {
    const { select, remove } = await bothStatements('mica_blabber_dms');

    expect(select.params).toEqual([90, 'mica_blabber_dms', 'mica_accounts', 'mica_blabber_dms']);
    expect(remove.params).toEqual([
      'expired',
      1,
      90,
      'mica_blabber_dms',
      'mica_accounts',
      'mica_blabber_dms'
    ]);
    for (const statement of [select, remove]) {
      expect((statement.sql.match(/\?/g) ?? []).length).toBe(statement.params.length);
    }
  });

  it('media: every attaching table is found, and holds while its parent row is shown', () => {
    const refs = liveReferences('mica_media');

    expect(refs).toEqual(
      expect.arrayContaining([
        {
          child: 'mica_messages_attachments',
          column: 'photo_id',
          parentTable: 'mica_messages',
          parentColumn: 'message_id'
        },
        {
          child: 'mica_blabber_attachments',
          column: 'media_id',
          parentTable: 'mica_blabber',
          parentColumn: 'blab_id'
        },
        {
          child: 'mica_marketplace_attachments',
          column: 'media_id',
          parentTable: 'mica_marketplace',
          parentColumn: 'listing_id'
        }
      ])
    );
    expect(refs).toHaveLength(3);
  });

  for (const [child, column, parent, parentColumn] of [
    ['mica_messages_attachments', 'photo_id', 'mica_messages', 'message_id'],
    ['mica_blabber_attachments', 'media_id', 'mica_blabber', 'blab_id'],
    ['mica_marketplace_attachments', 'media_id', 'mica_marketplace', 'listing_id']
  ]) {
    it(`media: a photo attached through ${child} is held in the select and the update`, async () => {
      const { select, remove } = await bothStatements('mica_media');

      for (const [statement, row] of [
        [select, 't'],
        [remove, '`mica_media`']
      ] as const) {
        // A parent kept but hidden — deleted, expired, erased (MICA-428) — holds nothing.
        expect(statement.sql).toContain(
          `NOT EXISTS (SELECT 1 FROM \`${child}\` a JOIN \`${parent}\` p ` +
            `ON p.\`id\` = a.\`${parentColumn}\` ` +
            "AND p.`status` NOT IN ('deleted', 'expired', 'erased') " +
            `WHERE a.\`${column}\` = ${row}.\`id\`)`
        );
      }
    });
  }

  it('the count the grace announces carries every hold too', async () => {
    db.markers.clear();
    expired('mica_media', 0);

    await pruneTable(policy('mica_media'));

    const count = calls().find((c) =>
      c.sql.startsWith('SELECT COUNT(*) AS `n` FROM `mica_media`')
    )!;
    expect(count.sql).toBe(
      "SELECT COUNT(*) AS `n` FROM `mica_media` t WHERE t.`status` = 'active' " +
        'AND t.`created_at` < NOW() - INTERVAL ? DAY AND ' +
        holdClause(policy('mica_media'), 't').sql
    );
  });

  it('never writes to mica_reports', async () => {
    expired('mica_messages', 3);

    await pruneTable(policy('mica_messages'));

    for (const { sql } of calls()) {
      expect(sql).not.toMatch(/^(DELETE FROM|UPDATE|INSERT INTO) `mica_reports`/);
    }
  });
});

describe('the first-run grace', () => {
  /** Window announcements; a switch-off writes `retention-off:` instead (`offWrites`). */
  const markerWrites = () =>
    calls().filter(
      (c) => c.sql.startsWith('INSERT INTO') && String(c.params[0]).startsWith('retention:')
    );
  const offWrites = () =>
    calls().filter(
      (c) => c.sql.startsWith('INSERT INTO') && String(c.params[0]).startsWith('retention-off:')
    );

  it('on the first start: counts, writes the marker, warns once, and hides nothing', async () => {
    // A pinned clock makes the announced deadline exact; afterEach restores real timers.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    db.markers.clear();
    expired('mica_messages', 42);

    expect(await pruneTable(policy('mica_messages'))).toBe(0);

    expect(expiresOf('mica_messages')).toEqual([]);
    expect(selects()).toEqual([]);
    expect(markerWrites()).toHaveLength(1);
    expect(markerWrites()[0].sql).toContain('`mica_schema_migrations`');
    expect(markerWrites()[0].params).toEqual(['retention:mica_messages:180d']);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const line = String((console.warn as any).mock.calls[0][0]);
    expect(line).toMatch(
      /^\[mica\] retention: 42 mica_messages rows are older than 180 days and will be hidden from \S+Z\. Every row is kept; set mica_message_retention "0" to keep showing them\.$/
    );
    const deadline = Date.parse(/hidden from (\S+)\. /.exec(line)![1]);
    expect(deadline).toBe(Date.now() + RETENTION_GRACE_MS);
  });

  it('keeps the original deadline across a restart inside the grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    db.markers.clear();
    db.markers.set('retention:mica_messages:180d', 10 * 60 * 60);
    expired('mica_messages', 42);

    expect(await pruneTable(policy('mica_messages'))).toBe(0);

    expect(expiresOf('mica_messages')).toEqual([]);
    expect(markerWrites()).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
    const line = String((console.log as any).mock.calls.at(-1)[0]);
    const deadline = Date.parse(/before (\S+)\.$/.exec(line)![1]);
    expect(deadline).toBe(Date.now() + 14 * 60 * 60 * 1000);
  });

  it('prunes on a start 25 hours after the marker', async () => {
    db.markers.clear();
    db.markers.set('retention:mica_messages:180d', 25 * 60 * 60);
    expired('mica_messages', 5);

    expect(await pruneTable(policy('mica_messages'))).toBe(5);
    expect(markerWrites()).toEqual([]);
  });

  it('runs the first real prune when the grace ends, without waiting for the six-hourly tick', async () => {
    vi.useFakeTimers();
    db.markers.clear();
    expired('mica_messages', 5);

    await pruneTable(policy('mica_messages'));
    expect(expiresOf('mica_messages')).toEqual([]);

    db.markers.set('retention:mica_messages:180d', DAY_S);
    await vi.advanceTimersByTimeAsync(RETENTION_GRACE_MS);

    expect(expiresOf('mica_messages').length).toBeGreaterThan(0);
  });

  it('hides nothing ever when the convar is set to 0 during the grace', async () => {
    vi.useFakeTimers();
    db.markers.clear();
    expired('mica_messages', 5);
    await pruneTable(policy('mica_messages'));

    withConvar({ mica_message_retention: '0' });
    await vi.advanceTimersByTimeAsync(RETENTION_GRACE_MS + RETENTION_INTERVAL_MS);
    await runRetention();

    expect(expiresOf('mica_messages')).toEqual([]);
  });

  it('a shorter window is a fresh announcement, with its own 24 hours', async () => {
    db.markers.clear();
    db.markers.set('retention:mica_messages:180d', 30 * DAY_S);
    withConvar({ mica_message_retention: '30' });
    expired('mica_messages', 7);

    expect(await pruneTable(policy('mica_messages'))).toBe(0);

    expect(markerWrites()[0].params).toEqual(['retention:mica_messages:30d']);
    expect(String((console.warn as any).mock.calls[0][0])).toContain(
      '7 mica_messages rows are older than 30 days'
    );
  });

  it('a longer window is covered by a shorter one announced within 30 days', async () => {
    db.markers.clear();
    db.markers.set('retention:mica_messages:180d', 10 * DAY_S);
    withConvar({ mica_message_retention: '365' });
    expired('mica_messages', 4);

    expect(await pruneTable(policy('mica_messages'))).toBe(4);
    expect(markerWrites()).toEqual([]);
  });

  it('a shorter window announced over 30 days ago covers nothing: a fresh grace and count', async () => {
    db.markers.clear();
    db.markers.set('retention:mica_messages:7d', 365 * DAY_S);
    db.markers.set('retention:mica_messages:180d', 200 * DAY_S);
    withConvar({ mica_message_retention: '30' });
    expired('mica_messages', 9);

    expect(await pruneTable(policy('mica_messages'))).toBe(0);

    expect(markerWrites()[0].params).toEqual(['retention:mica_messages:30d']);
    expect(String((console.warn as any).mock.calls[0][0])).toContain(
      '9 mica_messages rows are older than 30 days'
    );
  });

  it('the marker for exactly the current window counts however old it is', async () => {
    db.markers.clear();
    db.markers.set('retention:mica_messages:180d', 400 * DAY_S);
    expired('mica_messages', 2);

    expect(await pruneTable(policy('mica_messages'))).toBe(2);
    expect(markerWrites()).toEqual([]);
  });

  it('finds its markers with an unescaped LIKE, and trusts only its own ids', async () => {
    db.markers.clear();
    // `_` is a LIKE wildcard, so this sibling id matches the pattern; it must not count.
    db.markers.set('retention:micaXmessages:1d', 400 * DAY_S);
    expired('mica_messages', 2);

    expect(await pruneTable(policy('mica_messages'))).toBe(0);

    const read = calls().find((c) => c.sql.startsWith('SELECT m.`id` AS `id`, TIMESTAMPDIFF'))!;
    expect(read.params).toEqual(['retention:mica_messages:%', 'retention-off:mica_messages']);
    expect(String(read.params[0])).not.toContain('\\');
    expect(markerWrites()[0].params).toEqual(['retention:mica_messages:180d']);
  });

  it('forgetting writes an off marker for the table, and deletes no marker (MICA-428)', async () => {
    db.markers.clear();
    db.markers.set('retention:mica_messages:180d', DAY_S);
    db.markers.set('retention:micaXmessages:1d', DAY_S);
    withConvar({ mica_message_retention: 'off' });

    await pruneTable(policy('mica_messages'));

    expect(offWrites().map((c) => c.params)).toEqual([['retention-off:mica_messages']]);
    expect(calls().some((c) => /DELETE/.test(c.sql))).toBe(false);
    expect([...db.markers.keys()].toSorted()).toEqual([
      'retention-off:mica_messages',
      'retention:micaXmessages:1d',
      'retention:mica_messages:180d'
    ]);

    // Written once: a table left off is not rewritten every six hours.
    dbMock.query.mockClear();
    await pruneTable(policy('mica_messages'));
    expect(offWrites()).toEqual([]);
  });

  it('switching off forgets the announcement, so switching back on starts a fresh grace', async () => {
    db.markers.clear();
    db.markers.set('retention:mica_messages:180d', 30 * DAY_S);
    db.markers.set('retention:mica_media:365d', 30 * DAY_S);

    withConvar({ mica_message_retention: 'off' });
    await pruneTable(policy('mica_messages'));
    // Kept, and void: announced before the off marker.
    expect(db.markers.has('retention:mica_messages:180d')).toBe(true);
    expect(db.markers.get('retention-off:mica_messages')).toBe(0);

    withConvar({});
    expired('mica_messages', 3);
    expect(await pruneTable(policy('mica_messages'))).toBe(0);
    expect(markerWrites()[0].params).toEqual(['retention:mica_messages:180d']);
  });

  it('hides nothing when the ledger cannot be read', async () => {
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = flat(sql);
      if (text.startsWith('SELECT m.`id` AS `id`, TIMESTAMPDIFF')) {
        throw new Error('lock wait timeout');
      }
      return bookkeeping(text, params) ?? [{ id: 1 }];
    });

    await expect(pruneTable(policy('mica_messages'))).rejects.toThrow();
    expect(expiresOf('mica_messages')).toEqual([]);
  });
});

describe('what apply brings', () => {
  it('skips a table without its created_at key, and says so once', async () => {
    db.unindexed.add('mica_blabber_dms');
    expired('mica_blabber_dms', 3);

    expect(await pruneTable(policy('mica_blabber_dms'))).toBe(0);
    expect(await pruneTable(policy('mica_blabber_dms'))).toBe(0);

    expect(selects()).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String((console.warn as any).mock.calls[0][0])).toBe(
      '[mica] retention: mica_blabber_dms is not indexed yet — run micaschema apply; nothing is pruned until then.'
    );
  });

  it('still prunes the tables that are indexed', async () => {
    db.unindexed.add('mica_blabber_dms');
    expired('mica_messages', 2);

    expect(await pruneTable(policy('mica_messages'))).toBe(2);
  });

  it('without the ledger: one explanatory line, not a failure every six hours', async () => {
    vi.useFakeTimers();
    db.ledger = false;
    expired('mica_messages', 2);

    onRetentionResourceStart('mica');
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS * 3);

    expect(console.error).not.toHaveBeenCalled();
    const ledgerLines = (console.warn as any).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.includes('mica_schema_migrations does not exist yet'));
    expect(ledgerLines).toHaveLength(1);
    expect(expiresOf('mica_messages')).toEqual([]);
  });
});

describe('the schedule', () => {
  it('runs every table once at resource start, then every six hours', async () => {
    vi.useFakeTimers();
    // Registered with the runtime, not merely exported.
    expect(startHandlers).toContain(onRetentionResourceStart);

    onRetentionResourceStart('some-other-resource');
    await vi.advanceTimersByTimeAsync(0);
    expect(dbMock.query).not.toHaveBeenCalled();

    onRetentionResourceStart('mica');
    await vi.advanceTimersByTimeAsync(0);
    const firstRun = selects().length;
    expect(firstRun).toBe(retentionPolicies().length);

    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(selects().length).toBe(firstRun * 2);
  });

  it('starts once however often resource start fires', async () => {
    vi.useFakeTimers();

    onRetentionResourceStart('mica');
    onRetentionResourceStart('mica');
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);

    expect(selects().length).toBe(retentionPolicies().length * 2);
  });

  it('carries on past a table that fails, and never rejects', async () => {
    dbMock.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = flat(sql);
      if (text.includes('FROM `mica_messages` t')) throw new Error('no such table');
      return bookkeeping(text, params) ?? [];
    });

    await expect(runRetention()).resolves.toBeDefined();
    const tables = selects().map((c) => /FROM `(\w+)`/.exec(c.sql)?.[1]);
    expect(tables).toEqual(expect.arrayContaining(['mica_blabber_dms', 'mica_media']));
    expect(console.error).toHaveBeenCalled();
  });

  it('knows when a table is mid-prune, so the console command can say so', async () => {
    vi.useFakeTimers();
    expired('mica_media', RETENTION_BATCH + 1);

    const run = pruneTable(policy('mica_media'));
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(isRetentionRunning('mica_media')).toBe(true);

    await vi.runAllTimersAsync();
    await run;
    expect(isRetentionRunning('mica_media')).toBe(false);
  });
});

describe('registration', () => {
  it('refuses a table name that is not a plain identifier', () => {
    expect(() =>
      registerRetention({
        label: 'x',
        table: 'mica_x; DROP TABLE players',
        convar: 'x',
        days: () => 1
      })
    ).toThrow(/refusing/);
  });

  it('refuses a second policy for the same table', () => {
    expect(() =>
      registerRetention({ label: 'x', table: 'mica_messages', convar: 'x', days: () => 1 })
    ).toThrow(/already registered/);
  });
});
