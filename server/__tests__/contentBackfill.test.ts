// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * MICA-165: `micacrypt status` and `backfill` over an in-memory stand-in for the database.
 *
 * The stand-in answers the walk's own statements by shape — the keyset page, the
 * compare-and-set `UPDATE`, the column's capacity, the enabled marker, the notification
 * batches — so these cases can assert what each run counts and writes. Whether the statements
 * are valid MariaDB, and that `updated_at` really stays put, is `scripts/test-schema.js`'s.
 */
type Row = Record<string, any> & { id: number };

const store = vi.hoisted(() => ({
  tables: new Map<string, Row[]>(),
  capacity: new Map<string, number>(),
  marker: false,
  pages: [] as { table: string; after: number; limit: number }[],
  updates: [] as string[],
  /** Runs once, just before the next compare-and-set: a player editing mid-run. */
  beforeUpdate: null as null | (() => void)
}));

const dbMock = vi.hoisted(() => {
  const query = async (raw: string, params: any[] = []): Promise<any> => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (sql.includes('information_schema.COLUMNS')) {
      const n = store.capacity.get(`${params[0]}.${params[1]}`);
      return n === undefined ? [] : [{ n }];
    }
    if (sql.includes('information_schema.TABLES')) return [{ n: 1 }];
    if (sql.startsWith('SELECT COUNT(*) AS `n` FROM `mica_schema_migrations`')) {
      return [{ n: store.marker ? 1 : 0 }];
    }
    if (sql.startsWith('INSERT IGNORE INTO `mica_schema_migrations`')) {
      store.marker = true;
      return { affectedRows: 1 };
    }
    const notes = store.tables.get('mica_notifications') ?? [];
    const dm = (r: Row, p: any[]) => r.app === p[0] && r.kind === p[1] && r.body !== '';
    if (sql.startsWith('SELECT COUNT(*) AS `n` FROM `mica_notifications`')) {
      return [{ n: notes.filter((r) => dm(r, params)).length }];
    }
    if (sql.startsWith('SELECT `id` FROM `mica_notifications`')) {
      const [after, app, kind, limit] = params;
      return notes
        .filter((r) => r.id > after && dm(r, [app, kind]))
        .toSorted((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((r) => ({ id: r.id }));
    }
    if (sql.startsWith('UPDATE `mica_notifications`')) {
      store.updates.push(sql);
      const ids = params.slice(0, -2);
      const [app, kind] = params.slice(-2);
      let affectedRows = 0;
      for (const r of notes) {
        if (ids.includes(r.id) && dm(r, [app, kind])) {
          r.body = '';
          affectedRows += 1;
        }
      }
      return { affectedRows };
    }
    const paged = /^SELECT (.+) FROM `([a-z_]+)` WHERE `id` > \? ORDER BY `id` LIMIT \?$/.exec(sql);
    if (paged) {
      const columns = paged[1].split(', ').map((c) => c.replace(/`/g, ''));
      const [after, limit] = params;
      store.pages.push({ table: paged[2], after, limit });
      return (store.tables.get(paged[2]) ?? [])
        .filter((r) => r.id > after)
        .toSorted((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));
    }
    throw new Error(`contentBackfill.test: no stand-in answer for: ${sql}`);
  };

  const update = async (raw: string, params: any[] = []): Promise<boolean> => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    store.updates.push(sql);
    if (store.beforeUpdate) {
      const hook = store.beforeUpdate;
      store.beforeUpdate = null;
      hook();
    }
    const cas =
      /^UPDATE `([a-z_]+)` SET `([a-z_]+)` = \?(?:, `updated_at` = `updated_at`)? WHERE `id` = \? AND CAST\(`[a-z_]+` AS BINARY\) = \?((?: AND CAST\(`[a-z_]+` AS BINARY\) <=> CAST\(\? AS BINARY\))*)$/.exec(
        sql
      );
    if (!cas) throw new Error(`contentBackfill.test: no stand-in answer for: ${sql}`);
    const [, table, column, scopeSql] = cas;
    const scope = [...scopeSql.matchAll(/`([a-z_]+)` AS BINARY\) <=>/g)].map((m) => m[1]);
    const [value, id, was, ...bound] = params;
    const row = (store.tables.get(table) ?? []).find((r) => r.id === id);
    if (!row || row[column] !== was) return false;
    if (scope.some((name, i) => (row[name] ?? null) !== bound[i])) return false;
    row[column] = value;
    return true;
  };

  return { query: vi.fn(query), update: vi.fn(update), scalar: vi.fn(), insert: vi.fn() };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  UNREADABLE_CONTENT,
  contentContext,
  openContent,
  registerEncryptedColumn,
  resetContentCipherForTests,
  sealContent,
  sealedKeyId,
  unregisterEncryptedColumnForTests,
  type EncryptedColumn
} from '../lib/contentCipher';
import {
  MAX_BATCH,
  NoActiveKeyError,
  formatBackfill,
  formatStatus,
  walkContent,
  type ColumnReport,
  type ContentReport
} from '../lib/contentBackfill';

const THREADS: EncryptedColumn = {
  table: 'test_threads',
  column: 'body',
  scope: ['thread_id'],
  hasUpdatedAt: true
};
const LETTERS: EncryptedColumn = {
  table: 'test_letters',
  column: 'content',
  scope: [],
  hasUpdatedAt: false
};
registerEncryptedColumn(THREADS);
registerEncryptedColumn(LETTERS);

const dir = mkdtempSync(join(tmpdir(), 'mica-backfill-key-'));
afterAll(() => {
  unregisterEncryptedColumnForTests(THREADS.table, THREADS.column);
  unregisterEncryptedColumnForTests(LETTERS.table, LETTERS.column);
  rmSync(dir, { recursive: true, force: true });
});

/** A keyring line for a fresh random key. */
const keyLine = (kid: string): string => `${kid} ${randomBytes(32).toString('base64')}`;

let files = 0;
/** A key file holding these lines, first one active. */
const keyFileOf = (lines: string[]): string => {
  files += 1;
  const path = join(dir, `keys-${files}`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  chmodSync(path, 0o600);
  return path;
};
const keyFile = (kids: string[]): string => keyFileOf(kids.map(keyLine));

/** Point the convar at `path` (or at nothing) and forget the loaded keyring. */
const useKeys = (path: string): void => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_content_key_file' ? path : fallback;
  resetContentCipherForTests();
};

const seal = async (entry: EncryptedColumn, row: Row, plaintext: string): Promise<string> =>
  await sealContent(contentContext(entry, row), plaintext);

const open = (entry: EncryptedColumn, row: Row): string =>
  openContent(contentContext(entry, row), row[entry.column], row.id);

const column = (report: ContentReport, entry: EncryptedColumn): ColumnReport => {
  const found = report.columns.find((c) => c.table === entry.table && c.column === entry.column);
  if (!found) throw new Error(`no report for ${entry.table}`);
  return found;
};

const threads = (): Row[] => store.tables.get(THREADS.table)!;
const letters = (): Row[] => store.tables.get(LETTERS.table)!;
const noPause = async (): Promise<void> => {};

beforeEach(() => {
  store.tables = new Map([
    [THREADS.table, []],
    [LETTERS.table, []],
    ['mica_notifications', []]
  ]);
  store.capacity = new Map([
    ['test_threads.body', 65_535],
    ['test_letters.content', 65_535]
  ]);
  store.marker = false;
  store.pages = [];
  store.updates = [];
  store.beforeUpdate = null;
  useKeys('');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * One of every kind of value: plaintext, sealed with a key since retired from first place
 * (`old`), sealed with the active key (`new`), sealed with a key nobody has (`lost`), a damaged
 * sealed value, a plaintext too long to seal, and NULL.
 */
const seedMixed = async (): Promise<void> => {
  const oldLine = keyLine('old');
  const oldPath = keyFileOf([oldLine]);
  const lostPath = keyFile(['lost']);
  const t = (id: number, body: string | null): Row => ({
    id,
    citizenid: 'CIT_A',
    thread_id: 7,
    body,
    updated_at: '2020-01-01 00:00:00'
  });
  const rows: Row[] = [t(1, 'plain one'), t(2, null), t(3, 'x'.repeat(60_000))];

  useKeys(oldPath);
  const older = t(4, null);
  older.body = await seal(THREADS, older, 'sealed with old');
  rows.push(older);

  useKeys(lostPath);
  const lost = t(5, null);
  lost.body = await seal(THREADS, lost, 'nobody can read this');
  rows.push(lost, t(6, '$mc1$new$not-base64!'));

  // Rotated: a new key first, the same `old` key after it.
  useKeys(keyFileOf([keyLine('new'), oldLine]));
  const current = t(7, null);
  current.body = await seal(THREADS, current, 'already new');
  rows.push(current, t(8, 'plain two'));

  store.tables.set(THREADS.table, rows);
  store.tables.set(LETTERS.table, [
    { id: 1, citizenid: 'CIT_B', content: 'Your invoice is due' },
    { id: 2, citizenid: 'CIT_A', content: 'Welcome to Los Santos' }
  ]);
  store.tables.set('mica_notifications', [
    { id: 1, app: 'blabber', kind: 'dm', body: 'meet me at 10', updated_at: 'then' },
    { id: 2, app: 'blabber', kind: 'dm', body: '', updated_at: 'then' },
    { id: 3, app: 'blabber', kind: 'mention', body: '@alice hi', updated_at: 'then' },
    { id: 4, app: 'blabber', kind: 'dm', body: 'second dm', updated_at: 'then' }
  ]);
  store.updates = [];
  store.pages = [];
};

const DM = { app: 'blabber', kind: 'dm' };

describe('micacrypt status and the dry run', () => {
  it('counts every kind of value per column and writes nothing', async () => {
    await seedMixed();
    const before = JSON.stringify([...store.tables]);

    const report = await walkContent({ apply: false, notifications: DM, pause: noPause });

    expect(report).toMatchObject({ apply: false, activeKey: 'new', loadedKeys: ['new', 'old'] });
    expect(column(report, THREADS)).toMatchObject({
      missing: false,
      rows: 8,
      empty: 1,
      active: 1,
      older: { old: 1 },
      legacy: 2,
      unreadable: 2,
      tooLong: 1,
      sealed: 0,
      raced: 0
    });
    expect(column(report, LETTERS)).toMatchObject({ rows: 2, legacy: 2, active: 0 });
    expect(report.notifications).toEqual({ pending: 2, blanked: 0 });
    expect(store.updates).toEqual([]);
    expect(JSON.stringify([...store.tables])).toBe(before);

    const status = formatStatus(report).join('\n');
    expect(status).toContain("sealing with key 'new'; loaded: new, old.");
    expect(status).toContain(
      'test_threads.body: 8 row(s) — active key 1, older keys 1 (old), plaintext 2, ' +
        'unreadable 2, too long to seal 1, empty 1.'
    );
    expect(status).toContain('DM notifications still holding a body: 2.');
    expect(formatBackfill(report).join('\n')).toContain('would seal 3 (plaintext 2, older keys');
  });

  it('reads every sealed value as unreadable with no key, and says so', async () => {
    await seedMixed();
    useKeys('');

    const report = await walkContent({ apply: false, pause: noPause });

    expect(report.activeKey).toBeNull();
    expect(column(report, THREADS)).toMatchObject({ legacy: 2, unreadable: 4, active: 0 });
    expect(report.key).toEqual({ kind: 'missing' });
    expect(formatBackfill(report)[0]).toContain('--apply would refuse');
  });

  it('says which of the key states holds, and only one of them stores plaintext', async () => {
    const none = await walkContent({ apply: false, pause: noPause });
    expect(none.key).toEqual({ kind: 'none' });
    expect(formatStatus(none)[0]).toBe(
      '[micacrypt] no content key is set; new bodies are stored as plaintext.'
    );

    // Nothing set, but something was sealed once: writes are refused, not stored plain.
    store.marker = true;
    resetContentCipherForTests();
    const missing = await walkContent({ apply: false, pause: noPause });
    expect(missing.key).toEqual({ kind: 'missing' });
    expect(formatStatus(missing)[0]).toContain('mica_content_key_file is not set');
    expect(formatStatus(missing)[0]).toContain('every write of a body is refused');

    const path = join(dir, 'not-there.key');
    useKeys(path);
    const refused = await walkContent({ apply: false, pause: noPause });
    expect(refused.key).toEqual({ kind: 'refused', path });
    expect(formatStatus(refused)[0]).toContain(`the key file ${path} was refused`);
    expect(formatStatus(refused)[0]).toContain('every write of a body is refused');

    useKeys(keyFile(['k1']));
    const loaded = await walkContent({ apply: false, pause: noPause });
    expect(loaded.key).toEqual({ kind: 'loaded' });
    expect(formatStatus(loaded)[0]).toBe("[micacrypt] sealing with key 'k1'; loaded: k1.");
  });

  it('reports a column the database does not have, and walks the rest', async () => {
    store.capacity.delete('test_letters.content');
    store.tables.set(THREADS.table, [{ id: 1, citizenid: 'A', thread_id: 1, body: 'hi' }]);

    const report = await walkContent({ apply: false, pause: noPause });

    expect(column(report, LETTERS)).toMatchObject({ missing: true, rows: 0 });
    expect(column(report, THREADS)).toMatchObject({ rows: 1, legacy: 1 });
    expect(store.pages.some((p) => p.table === LETTERS.table)).toBe(false);
    expect(formatStatus(report).join('\n')).toContain(
      'test_letters.content: not in the database; run micaschema apply.'
    );
  });
});

describe('micacrypt backfill --apply', () => {
  it('seals plaintext, re-seals an older key, and leaves the rest exactly as they were', async () => {
    await seedMixed();
    const untouched = [2, 3, 5, 6, 7].map((id) => ({ ...threads().find((r) => r.id === id)! }));

    const report = await walkContent({ apply: true, notifications: DM, pause: noPause });

    expect(column(report, THREADS)).toMatchObject({ sealed: 3, raced: 0, legacy: 2 });
    expect(column(report, LETTERS)).toMatchObject({ sealed: 2, raced: 0 });

    const byId = new Map(threads().map((r) => [r.id, r]));
    for (const [id, plaintext] of [
      [1, 'plain one'],
      [4, 'sealed with old'],
      [8, 'plain two']
    ] as const) {
      const row = byId.get(id)!;
      expect(sealedKeyId(row.body), `row ${id}`).toBe('new');
      expect(open(THREADS, row), `row ${id}`).toBe(plaintext);
    }
    for (const was of untouched) expect(byId.get(was.id)).toEqual(was);
    expect(letters().map((r) => open(LETTERS, r))).toEqual([
      'Your invoice is due',
      'Welcome to Los Santos'
    ]);
    // Sealed for its own row: moved to another citizen, it no longer opens.
    expect(openContent(contentContext(LETTERS, { citizenid: 'CIT_A' }), letters()[0].content)).toBe(
      UNREADABLE_CONTENT
    );

    // `updated_at` pinned where the table has one, not named where it has none.
    const casThreads = store.updates.filter((s) => s.startsWith('UPDATE `test_threads`'));
    const casLetters = store.updates.filter((s) => s.startsWith('UPDATE `test_letters`'));
    expect(casThreads).toHaveLength(3);
    expect(casThreads.every((s) => s.includes('`updated_at` = `updated_at`'))).toBe(true);
    expect(casLetters.every((s) => !s.includes('updated_at'))).toBe(true);
    // The row's citizen and thread are part of the compare, not just its id.
    expect(casThreads[0]).toContain(
      'AND CAST(`citizenid` AS BINARY) <=> CAST(? AS BINARY) ' +
        'AND CAST(`thread_id` AS BINARY) <=> CAST(? AS BINARY)'
    );

    expect(store.tables.get('mica_notifications')!.map((r) => r.body)).toEqual([
      '',
      '',
      '@alice hi',
      ''
    ]);
    expect(report.notifications).toEqual({ pending: 0, blanked: 2 });
    expect(store.marker).toBe(true);

    const printed = formatBackfill(report).join('\n');
    expect(printed).toContain("backfill with key 'new':");
    expect(printed).toContain('test_threads.body: 8 row(s) — sealed 3');
    expect(printed).toContain('changed mid-run, left for the next run 0');
    expect(printed).toContain('DM notification bodies blanked: 2; still holding one: 0.');
  });

  it('writes nothing on a second run', async () => {
    await seedMixed();
    await walkContent({ apply: true, notifications: DM, pause: noPause });
    const after = JSON.stringify([...store.tables]);
    store.updates = [];

    const again = await walkContent({ apply: true, notifications: DM, pause: noPause });

    expect(store.updates).toEqual([]);
    expect(JSON.stringify([...store.tables])).toBe(after);
    expect(column(again, THREADS)).toMatchObject({ sealed: 0, active: 4, legacy: 0, older: {} });
    expect(column(again, LETTERS)).toMatchObject({ sealed: 0, active: 2 });
    expect(again.notifications).toEqual({ pending: 0, blanked: 0 });
  });

  it('leaves a row edited between the read and the write for the next run', async () => {
    const path = keyFile(['new']);
    useKeys(path);
    store.tables.set(THREADS.table, [
      { id: 1, citizenid: 'CIT_A', thread_id: 7, body: 'first draft' },
      { id: 2, citizenid: 'CIT_A', thread_id: 7, body: 'untouched' }
    ]);
    // The player edits row 1 after the page was read. Only case changes, which a
    // case-insensitive compare would have let the backfill overwrite.
    store.beforeUpdate = () => {
      threads()[0].body = 'FIRST DRAFT';
    };

    const report = await walkContent({ apply: true, pause: noPause });

    expect(column(report, THREADS)).toMatchObject({ sealed: 1, raced: 1 });
    expect(threads()[0].body).toBe('FIRST DRAFT');
    expect(open(THREADS, threads()[1])).toBe('untouched');

    const next = await walkContent({ apply: true, pause: noPause });
    expect(column(next, THREADS)).toMatchObject({ sealed: 1, raced: 0, active: 1 });
    expect(open(THREADS, threads()[0])).toBe('FIRST DRAFT');
  });

  it('re-seals a body that is literally the padlock, rather than taking it for unreadable', async () => {
    const oldLine = keyLine('old');
    useKeys(keyFileOf([oldLine]));
    const row: Row = { id: 1, citizenid: 'CIT_A', thread_id: 7, body: null };
    row.body = await seal(THREADS, row, UNREADABLE_CONTENT);
    store.tables.set(THREADS.table, [row]);
    useKeys(keyFileOf([keyLine('new'), oldLine]));

    const dry = await walkContent({ apply: false, pause: noPause });
    expect(column(dry, THREADS)).toMatchObject({ older: { old: 1 }, unreadable: 0 });

    const report = await walkContent({ apply: true, pause: noPause });
    expect(column(report, THREADS)).toMatchObject({ sealed: 1, unreadable: 0 });
    expect(sealedKeyId(threads()[0].body)).toBe('new');
    expect(open(THREADS, threads()[0])).toBe(UNREADABLE_CONTENT);
  });

  it('leaves a row whose thread changed between the read and the write', async () => {
    useKeys(keyFile(['new']));
    store.tables.set(THREADS.table, [{ id: 1, citizenid: 'CIT_A', thread_id: 7, body: 'moved' }]);
    store.beforeUpdate = () => {
      threads()[0].thread_id = 8;
    };

    const report = await walkContent({ apply: true, pause: noPause });

    expect(column(report, THREADS)).toMatchObject({ sealed: 0, raced: 1 });
    expect(threads()[0].body).toBe('moved');
  });

  it('leaves a row whose citizenid changed only in case between the read and the write', async () => {
    useKeys(keyFile(['new']));
    store.tables.set(THREADS.table, [{ id: 1, citizenid: 'CIT_A', thread_id: 7, body: 'hi' }]);
    store.beforeUpdate = () => {
      threads()[0].citizenid = 'cit_a';
    };

    const report = await walkContent({ apply: true, pause: noPause });

    expect(column(report, THREADS)).toMatchObject({ sealed: 0, raced: 1 });
    expect(threads()[0].body).toBe('hi');
  });

  it('refuses loudly with no key, before reading a row', async () => {
    store.tables.set(THREADS.table, [{ id: 1, citizenid: 'CIT_A', thread_id: 7, body: 'hi' }]);

    await expect(walkContent({ apply: true, pause: noPause })).rejects.toBeInstanceOf(
      NoActiveKeyError
    );
    expect(store.pages).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it('says whether the key file is not set or set and refused', async () => {
    await expect(walkContent({ apply: true, pause: noPause })).rejects.toThrow(
      'mica_content_key_file is not set'
    );

    const missing = join(dir, 'does-not-exist');
    useKeys(missing);
    const refused = walkContent({ apply: true, pause: noPause });
    await expect(refused).rejects.toBeInstanceOf(NoActiveKeyError);
    await expect(refused).rejects.toThrow(
      `mica_content_key_file is set to ${missing}, but that key file was refused`
    );
    expect(store.pages).toEqual([]);
  });
});

describe('the walk is bounded', () => {
  it('reads by id keyset a batch at a time, pausing between batches', async () => {
    useKeys(keyFile(['new']));
    store.tables.set(
      THREADS.table,
      [5, 1, 9, 3, 7].map((id) => ({ id, citizenid: 'CIT_A', thread_id: 1, body: `m${id}` }))
    );
    const pause = vi.fn(async () => {});

    const report = await walkContent({ apply: true, batch: 2, pause });

    expect(store.pages.filter((p) => p.table === THREADS.table)).toEqual([
      { table: THREADS.table, after: 0, limit: 2 },
      { table: THREADS.table, after: 3, limit: 2 },
      { table: THREADS.table, after: 7, limit: 2 }
    ]);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(column(report, THREADS)).toMatchObject({ rows: 5, sealed: 5 });
    // One row per statement: every write names one id.
    const writes = store.updates.filter((s) => s.startsWith('UPDATE `test_threads`'));
    expect(writes).toHaveLength(5);
    expect(writes.every((s) => s.includes('WHERE `id` = ?'))).toBe(true);
  });

  it('blanks notification bodies a batch at a time', async () => {
    useKeys(keyFile(['new']));
    store.tables.set(
      'mica_notifications',
      [1, 2, 3, 4, 5].map((id) => ({ id, app: 'blabber', kind: 'dm', body: `dm ${id}` }))
    );

    const report = await walkContent({ apply: true, batch: 2, notifications: DM, pause: noPause });

    expect(report.notifications).toEqual({ pending: 0, blanked: 5 });
    const writes = store.updates.filter((s) => s.startsWith('UPDATE `mica_notifications`'));
    expect(writes).toHaveLength(3);
    expect(writes.every((s) => s.includes('`updated_at` = `updated_at`'))).toBe(true);
  });

  it('refuses a batch size outside 1..MAX_BATCH', async () => {
    for (const batch of [0, -1, 1.5, MAX_BATCH + 1]) {
      await expect(walkContent({ apply: false, batch })).rejects.toBeInstanceOf(RangeError);
    }
  });
});
