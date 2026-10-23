// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock, commands } = vi.hoisted(() => {
  const registered: [string, (source: number, args: string[]) => void, boolean][] = [];
  // Captured before Storage.ts loads, since it registers at module scope.
  (globalThis as any).RegisterCommand = (
    name: string,
    handler: (source: number, args: string[]) => void,
    restricted: boolean
  ) => {
    registered.push([name, handler, restricted]);
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    commands: registered
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => null,
    getSourceByCitizenId: () => null,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {},
    isSyntheticAdmin: () => false
  }
}));

import {
  STORAGE_HEADER,
  TABLE_SIZES_SQL,
  countRowsSql,
  enumValues,
  formatStorageReport,
  readStorageReport,
  type StorageReport,
  type TableSize
} from '../lib/storageReport';
import { runStorageCommand } from '../services/Storage';

/** A citizenid that must never reach a line, planted where a careless read would find it. */
const CITIZEN = 'CID_SECRET_7';

interface WorldTable {
  name: string;
  dataBytes: unknown;
  indexBytes: unknown;
  statusType: string | null;
  [extra: string]: unknown;
}

/**
 * A small world: three status tables, the audit log and the ledger. `informationSchema` turns it
 * into what the size read's two branches answer.
 */
const SIZES: WorldTable[] = [
  {
    name: 'mica_notes',
    dataBytes: '16384',
    indexBytes: '32768',
    statusType: "enum('active','archived','deleted','moderated','erased')"
  },
  {
    name: 'mica_media',
    dataBytes: 5 * 1024 * 1024,
    indexBytes: 512 * 1024,
    statusType: "enum('active','deleted','moderated','expired','erased')"
  },
  { name: 'mica_schema_migrations', dataBytes: 16384, indexBytes: 0, statusType: null },
  { name: 'mica_odd', dataBytes: 16384, indexBytes: 16384, statusType: 'varchar(20)' },
  { name: 'mica_audit_logs', dataBytes: 1024 * 1024, indexBytes: 64 * 1024, statusType: null }
];

/** The count, keyed by each table's position in `SIZES`: `t`, `s`, `n` as the union answers. */
const COUNTS = [
  { t: 0, s: 'active', n: 7 },
  { t: 0, s: 'archived', n: 2 },
  { t: 0, s: 'erased', n: 1 },
  { t: 1, s: 'active', n: 40 },
  { t: 1, s: 'expired', n: 25 },
  { t: 1, s: 'deleted', n: '5' },
  // An ENUM's '' — a value written under a non-strict sql_mode, outside the declared list.
  { t: 1, s: '', n: 1 },
  { t: 2, s: null, n: 16 },
  { t: 3, s: 'active', n: 3 },
  { t: 3, s: 'pending', n: 4 },
  { t: 4, s: null, n: 900 }
];

/** A `k` 0 row per table, then a `k` 1 row per status column, as the union answers. */
const informationSchema = (world: readonly WorldTable[]) => [
  ...world.map(({ statusType: _type, ...table }) => ({ k: 0, ...table, statusType: null })),
  ...world
    .filter((table) => table.statusType !== null)
    .map((table) => ({
      ...table,
      k: 1,
      dataBytes: null,
      indexBytes: null
    }))
];

const answer = (world: readonly WorldTable[], counts: unknown[] | Error, extra: unknown[] = []) => {
  dbMock.query.mockImplementation(async (sql: string) => {
    if (sql === TABLE_SIZES_SQL) return [...informationSchema(world), ...extra];
    if (counts instanceof Error) throw counts;
    return counts;
  });
};

let logged: string[] = [];

const notifies = () =>
  (globalThis.emitNet as any).mock.calls.filter((c: any[]) => c[0] === 'mica:client:shell:notify');

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.emitNet = vi.fn() as any;
  (globalThis as any).GetConvar = (_n: string, fallback: string) => fallback;
  (globalThis as any).IsPlayerAceAllowed = () => false;
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enumValues', () => {
  it('reads an ENUM as information_schema spells it, a doubled quote included', () => {
    expect(enumValues("enum('active','deleted','erased')")).toEqual([
      'active',
      'deleted',
      'erased'
    ]);
    expect(enumValues("ENUM('it''s','x')")).toEqual(["it's", 'x']);
  });

  it('answers null for a type that is not an ENUM', () => {
    expect(enumValues('varchar(20)')).toBeNull();
  });
});

describe('the reads', () => {
  it('reads sizes and status columns in one statement, each branch narrowed by its own WHERE', () => {
    const [tables, columns, more] = TABLE_SIZES_SQL.split(' UNION ALL ');
    const mica = "TABLE_NAME LIKE 'mica|_%' ESCAPE '|'";
    expect(more).toBeUndefined();
    expect(tables).toMatch(/FROM information_schema\.TABLES WHERE /);
    expect(tables).toContain("TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    expect(tables).toContain(mica);
    expect(columns).toMatch(/FROM information_schema\.COLUMNS WHERE /);
    expect(columns).toContain('TABLE_SCHEMA = DATABASE()');
    expect(columns).toContain(mica);
    expect(columns).toContain("COLUMN_NAME = 'status'");
    // No join: MariaDB reads every table definition on the server for one (measured on 12.3).
    expect(TABLE_SIZES_SQL).not.toMatch(/\bJOIN\b/);
  });

  it('makes a table only of a name the TABLES branch answered, never of a view', async () => {
    answer(SIZES, COUNTS, [
      { k: 1, name: 'mica_some_view', dataBytes: null, indexBytes: null, statusType: "enum('a')" }
    ]);
    const report = await readStorageReport();
    expect(report.tables.map((t) => t.name)).not.toContain('mica_some_view');
    // Its positive twin: a status row whose table the first branch answered is read.
    expect(report.tables.find((t) => t.name === 'mica_notes')?.statuses).toEqual([
      'active',
      'archived',
      'deleted',
      'moderated',
      'erased'
    ]);
  });

  it('counts every table in one statement, by status where there is one', () => {
    const tables: TableSize[] = [
      { name: 'mica_notes', dataBytes: 0, indexBytes: 0, statuses: ['active', 'deleted'] },
      { name: 'mica_audit_logs', dataBytes: 0, indexBytes: 0, statuses: null },
      { name: 'mica_odd', dataBytes: 0, indexBytes: 0, statuses: [] }
    ];
    const branches = countRowsSql(tables).split(' UNION ALL ');

    expect(branches).toEqual([
      'SELECT 0 AS `t`, CONVERT(`status` USING utf8mb4) AS `s`, COUNT(*) AS `n` ' +
        'FROM `mica_notes` GROUP BY `status`',
      'SELECT 1 AS `t`, NULL AS `s`, COUNT(*) AS `n` FROM `mica_audit_logs`',
      'SELECT 2 AS `t`, CONVERT(`status` USING utf8mb4) AS `s`, COUNT(*) AS `n` ' +
        'FROM `mica_odd` GROUP BY `status`'
    ]);
  });

  it('selects nothing but a position, a status and a count — no column a row holds', () => {
    const tables: TableSize[] = SIZES.map((s) => ({
      name: s.name,
      dataBytes: 0,
      indexBytes: 0,
      statuses: s.statusType ? [] : null
    }));
    for (const branch of countRowsSql(tables).split(' UNION ALL ')) {
      const select = /^SELECT (.*) FROM /.exec(branch)?.[1];
      expect(select, branch).toMatch(
        /^\d+ AS `t`, (NULL|CONVERT\(`status` USING utf8mb4\)) AS `s`, COUNT\(\*\) AS `n`$/
      );
    }
    expect(countRowsSql(tables)).not.toMatch(/citizenid/i);
  });

  it('quotes a table name by doubling a backtick inside it', () => {
    const sql = countRowsSql([{ name: 'mica_a`b', dataBytes: 0, indexBytes: 0, statuses: null }]);
    expect(sql).toContain('FROM `mica_a``b`');
  });

  it('takes two round trips however many tables there are, and none when there are none', async () => {
    answer(SIZES, COUNTS);
    await readStorageReport();
    expect(dbMock.query).toHaveBeenCalledTimes(2);
    expect(dbMock.single).not.toHaveBeenCalled();
    expect(dbMock.scalar).not.toHaveBeenCalled();

    dbMock.query.mockClear();
    answer([], COUNTS);
    const empty = await readStorageReport();
    expect(dbMock.query).toHaveBeenCalledTimes(1);
    expect(empty.tables).toEqual([]);
  });

  it('orders the tables largest first and tallies each one by status', async () => {
    answer(SIZES, COUNTS);
    const report = await readStorageReport();

    expect(report.countFailure).toBeNull();
    expect(report.tables.map((t) => t.name)).toEqual([
      'mica_media',
      'mica_audit_logs',
      'mica_notes',
      'mica_odd',
      'mica_schema_migrations'
    ]);
    const media = report.tables[0];
    expect(media.statuses).toEqual(['active', 'deleted', 'moderated', 'expired', 'erased']);
    expect(media.rows?.total).toBe(71);
    expect(media.rows?.byStatus.get('deleted')).toBe(5);
    expect(report.tables.find((t) => t.name === 'mica_odd')?.statuses).toEqual([]);
    expect(report.tables.find((t) => t.name === 'mica_audit_logs')?.statuses).toBeNull();
  });
});

describe('formatStorageReport', () => {
  const report = async (counts: unknown[] | Error = COUNTS): Promise<StorageReport> => {
    answer(SIZES, counts);
    return await readStorageReport();
  };

  it('prints the header, a line per table largest first, and the total', async () => {
    expect(formatStorageReport(await report())).toEqual([
      STORAGE_HEADER,
      '[micastorage]   mica_media: 5.5MB (5.0MB data, 512.0KB index); 71 row(s): ' +
        '40 active, 31 inactive (deleted 5, expired 25, (empty) 1)',
      '[micastorage]   mica_audit_logs: 1.1MB (1.0MB data, 64.0KB index); ' +
        '900 row(s), no status column',
      '[micastorage]   mica_notes: 48.0KB (16.0KB data, 32.0KB index); 10 row(s): ' +
        '7 active, 3 inactive (archived 2, erased 1)',
      '[micastorage]   mica_odd: 32.0KB (16.0KB data, 16.0KB index); 7 row(s): ' +
        '3 active, 4 inactive (pending 4)',
      '[micastorage]   mica_schema_migrations: 16.0KB (16.0KB data, 0B index); ' +
        '16 row(s), no status column',
      '[micastorage] total: 5 table(s), 6.7MB (6.0MB data, 624.0KB index), 6979584 bytes; ' +
        '1004 row(s): 50 active, 38 inactive (expired 25, deleted 5, pending 4, archived 2, ' +
        '(empty) 1, erased 1), 916 in tables with no status.'
    ]);
  });

  it('keeps active apart from every other status, a status nobody listed here included', async () => {
    const lines = formatStorageReport(await report());
    const odd = lines.find((l) => l.includes('mica_odd:'));
    // `pending` is in no list in this repo: it came from the database, and is counted.
    expect(odd).toContain('3 active, 4 inactive (pending 4)');
  });

  it('prints the header first, so a reader can find the report by it', async () => {
    const lines = formatStorageReport(await report());
    expect(lines[0]).toBe(
      "[micastorage] mica_ tables, largest first. Sizes are InnoDB's estimates; row counts are exact."
    );
    expect(lines.at(-1)).toMatch(/^\[micastorage\] total: /);
  });

  it('prints a table with no rows as zero, not as missing', async () => {
    answer(
      [{ name: 'mica_notes', dataBytes: 16384, indexBytes: 0, statusType: "enum('active')" }],
      []
    );
    const lines = formatStorageReport(await readStorageReport());
    expect(lines[1]).toBe(
      '[micastorage]   mica_notes: 16.0KB (16.0KB data, 0B index); 0 row(s): 0 active, 0 inactive'
    );
  });

  it('still prints the sizes, and why, when the count fails', async () => {
    const lines = formatStorageReport(await report(new Error("Table 'mica.mica_x' is gone")));
    expect(lines[1]).toBe(
      "[micastorage] could not count rows (Table 'mica.mica_x' is gone); sizes only."
    );
    expect(lines[2]).toBe(
      '[micastorage]   mica_media: 5.5MB (5.0MB data, 512.0KB index); rows not counted'
    );
    expect(lines.at(-1)).toBe(
      '[micastorage] total: 5 table(s), 6.7MB (6.0MB data, 624.0KB index), 6979584 bytes; ' +
        'rows not counted.'
    );
  });

  it('says so when the database holds no mica_ table', async () => {
    answer([], []);
    expect(formatStorageReport(await readStorageReport())).toEqual([
      '[micastorage] no mica_ tables in this database.'
    ]);
  });
});

describe('micastorage command', () => {
  it('is registered as micastorage, with FiveM restriction off like every mica command', () => {
    expect(commands.map(([name, , restricted]) => [name, restricted])).toEqual([
      ['micastorage', false]
    ]);
  });

  it('runs from the console with no ace, prints the report, and sends no toast', async () => {
    answer(SIZES, COUNTS);
    await runStorageCommand(0);

    expect(logged[0]).toBe(STORAGE_HEADER);
    expect(logged.at(-1)).toMatch(/^\[micastorage\] total: 5 table\(s\)/);
    expect(notifies()).toHaveLength(0);
  });

  it('refuses a player with no admin ace before reading anything, and says so', async () => {
    answer(SIZES, COUNTS);
    await runStorageCommand(7);

    expect(dbMock.query).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
    expect(notifies()).toHaveLength(1);
    expect(notifies()[0][2]).toMatchObject({ type: 'error', key: 'server.storage.noPermission' });
  });

  it('reports to an in-game admin in the console and tells them in a toast', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    answer(SIZES, COUNTS);
    await runStorageCommand(7);

    expect(logged[0]).toBe(STORAGE_HEADER);
    expect(notifies()).toHaveLength(1);
    expect(notifies()[0][1]).toBe(7);
    expect(notifies()[0][2]).toMatchObject({
      type: 'success',
      key: 'server.storage.report',
      params: { tables: 5, size: '6.7MB' }
    });
  });

  it('runs through the registered handler, as the console reaches it', async () => {
    answer(SIZES, COUNTS);
    const [, handler] = commands[0];
    handler(0, []);
    await vi.waitFor(() => expect(logged.at(-1)).toMatch(/^\[micastorage\] total: /));
    expect(logged[0]).toBe(STORAGE_HEADER);
  });

  it('refuses a second report while one is reading, and runs again once it has finished', async () => {
    let release: (rows: unknown[]) => void = () => {};
    dbMock.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const first = runStorageCommand(0);
    await runStorageCommand(0);
    expect(logged).toEqual([
      '[micastorage] a report is already running; run micastorage again when it has finished.'
    ]);
    expect(dbMock.query).toHaveBeenCalledTimes(1);

    answer(SIZES, COUNTS);
    release(informationSchema(SIZES));
    await first;
    expect(logged[1]).toBe(STORAGE_HEADER);

    logged = [];
    await runStorageCommand(0);
    expect(logged[0]).toBe(STORAGE_HEADER);
  });

  it('tells an in-game admin a report is already running', async () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
    let release: (rows: unknown[]) => void = () => {};
    dbMock.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const first = runStorageCommand(0);
    await runStorageCommand(7);
    expect(notifies()[0][2]).toMatchObject({ type: 'error', key: 'server.storage.busy' });
    release([]);
    await first;
  });

  it('lets the next report run after one whose size read threw', async () => {
    dbMock.query.mockRejectedValueOnce(new Error('lost connection'));
    await expect(runStorageCommand(0)).rejects.toThrow('lost connection');

    answer(SIZES, COUNTS);
    await runStorageCommand(0);
    expect(logged[0]).toBe(STORAGE_HEADER);
  });

  it('prints no citizenid, though one sits in the rows information_schema answered', async () => {
    // Extra fields on a row, as a driver might hand back: none of them is ever read.
    answer(
      SIZES.map((s) => ({ ...s, citizenid: CITIZEN })),
      COUNTS.map((c) => ({ ...c, citizenid: CITIZEN }))
    );
    await runStorageCommand(0);

    // Its positive twin: the report did print, a line for every table.
    expect(logged.filter((l) => l.startsWith('[micastorage]   mica_'))).toHaveLength(5);
    expect(logged.join('\n')).not.toContain(CITIZEN);
  });
});
