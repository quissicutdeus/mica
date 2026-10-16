// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { Repository } from '../lib/Repository';
import {
  encryptedColumn,
  encryptedColumnsOf,
  openRows,
  registerEncryptedColumn,
  unregisterEncryptedColumnForTests
} from '../lib/contentCipher';
import { allow, __resetRateLimits } from '../lib/rateLimit';
import { __resetOwnerConfig, disabledApps, isAppDisabled } from '../lib/ownerConfig';

/**
 * MICA-378: what every request used to derive again — a repository's column sets, a table's
 * encrypted columns, two convars' parses — is derived once and reused. Each case pins either
 * that the reuse happens or that it cannot serve a stale answer.
 */

interface Row {
  id: number;
  citizenid: string;
  title: string;
  status: string;
}

class Repo extends Repository<Row> {
  protected tableName = 'mica_precomputed';
  protected columns: readonly string[] = ['id', 'citizenid', 'title', 'status'];
  protected clientWritable: readonly string[] = ['title', 'citizenid', 'status', 'missing'];
  protected clientFilterable: readonly string[] = ['title', 'citizenid'];

  /** A subclass that swaps its lists after construction, as `SchemaRepository` does. */
  public replace(columns: readonly string[], writable: readonly string[]): void {
    this.columns = columns;
    this.clientWritable = writable;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
  dbMock.update.mockResolvedValue(true);
});

describe('repository column sets', () => {
  it('derives the writable and filterable sets once, minus the never-client columns', () => {
    const repo = new Repo();

    const writable = repo.writableColumns;
    expect(writable).toEqual(['title']);
    expect(repo.writableColumns).toBe(writable);
    expect(repo.filterableColumns).toEqual(['title']);
    expect(repo.filterableColumns).toBe(repo.filterableColumns);
  });

  it('hands out a list no caller can grow into the allowlist', () => {
    const writable = new Repo().writableColumns as string[];
    expect(() => writable.push('citizenid')).toThrow(TypeError);
  });

  it('derives again when a subclass assigns new lists, rather than answering the old ones', async () => {
    const repo = new Repo();
    expect(repo.writableColumns).toEqual(['title']);

    repo.replace(['id', 'citizenid', 'body', 'status'], ['body']);

    expect(repo.writableColumns).toEqual(['body']);
    // The identifier allowlist follows too: the old column is refused, the new one is not.
    await expect(repo.update(1, { title: 'x' } as Partial<Row>, 'CID')).rejects.toThrow(
      /unknown column 'title'/
    );
    await expect(repo.update(1, { body: 'x' } as Partial<Row>, 'CID')).resolves.toBe(true);
  });

  it('still refuses an unknown column and still applies the owner and status predicates', async () => {
    const repo = new Repo();

    await expect(repo.findAll({ nope: 1 } as Partial<Row>)).rejects.toThrow(/unknown column/);
    await repo.update(1, { title: 'x' }, 'CID');

    const [sql] = dbMock.update.mock.calls[0];
    expect(sql).toContain('AND `citizenid` = ?');
    expect(sql).toContain("AND `status` != 'moderated'");
  });
});

describe('encrypted columns by table', () => {
  const ENTRY = { table: 'mica_precomputed_t', column: 'body', scope: [], hasUpdatedAt: true };

  afterEach(() => unregisterEncryptedColumnForTests(ENTRY.table, ENTRY.column));

  it('answers a registered column, and nothing once it is taken back out', () => {
    expect(encryptedColumnsOf(ENTRY.table)).toEqual([]);

    registerEncryptedColumn(ENTRY);
    expect(encryptedColumnsOf(ENTRY.table).map((entry) => entry.column)).toEqual(['body']);
    expect(encryptedColumn(ENTRY.table, 'body')?.table).toBe(ENTRY.table);
    expect(encryptedColumn(ENTRY.table, 'other')).toBeNull();

    unregisterEncryptedColumnForTests(ENTRY.table, ENTRY.column);
    expect(encryptedColumnsOf(ENTRY.table)).toEqual([]);
    expect(encryptedColumn(ENTRY.table, 'body')).toBeNull();
  });

  it('keeps one table out of another', () => {
    registerEncryptedColumn(ENTRY);
    expect(encryptedColumnsOf('mica_precomputed_other')).toEqual([]);
  });

  it('hands out a list no caller can add a column to', () => {
    registerEncryptedColumn(ENTRY);
    const entries = encryptedColumnsOf(ENTRY.table) as unknown[];
    expect(() => entries.push({})).toThrow(TypeError);
    expect(() => (encryptedColumnsOf('mica_none') as unknown[]).push({})).toThrow(TypeError);
  });

  it('still returns a copy of a result set with nothing to open', () => {
    const rows = [{ id: 1, body: 'plain' }];
    const opened = openRows('mica_none', rows);
    expect(opened).toEqual(rows);
    expect(opened).not.toBe(rows);
  });
});

describe('the rate-limit convar', () => {
  let value = '2';
  const read = vi.fn((name: string, fallback: string) =>
    name === 'mica_rate_limit' ? value : fallback
  );

  beforeEach(() => {
    __resetRateLimits();
    value = '2';
    read.mockClear();
    (globalThis as Record<string, unknown>).GetConvar = read;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).GetConvar = (_name: string, fallback: string) =>
      fallback;
  });

  it('is still read on every request, and a new value applies on the next one', () => {
    expect(allow(1, 'notes', 'create')).toBe(true);
    expect(allow(1, 'notes', 'create')).toBe(true);
    expect(allow(1, 'notes', 'create')).toBe(false);

    value = '5';
    expect(allow(1, 'notes', 'create')).toBe(true);

    expect(read).toHaveBeenCalledTimes(4);
  });

  it('falls back to the default again when the value turns invalid', () => {
    expect(allow(1, 'notes', 'create')).toBe(true);
    value = 'off';
    for (let i = 0; i < 59; i += 1) expect(allow(1, 'notes', 'create')).toBe(true);
    expect(allow(1, 'notes', 'create')).toBe(false);
  });
});

describe('the disabled-apps convar', () => {
  let value = 'mail';
  const read = vi.fn((name: string, fallback: string) =>
    name === 'mica_disabled_apps' ? value : fallback
  );

  beforeEach(() => {
    __resetOwnerConfig();
    value = 'mail';
    read.mockClear();
    (globalThis as Record<string, unknown>).GetConvar = read;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as Record<string, unknown>).GetConvar = (_name: string, fallback: string) =>
      fallback;
  });

  it('is still read on every check, and a new value applies on the next one', () => {
    expect(isAppDisabled('mail')).toBe(true);
    expect(isAppDisabled('notes')).toBe(false);

    value = 'notes';
    expect(isAppDisabled('mail')).toBe(false);
    expect(isAppDisabled('notes')).toBe(true);

    expect(read).toHaveBeenCalledTimes(4);
  });

  it('warns once per distinct value however many checks read it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    value = 'mail,Bad!';
    for (let i = 0; i < 5; i += 1) isAppDisabled('mail');
    disabledApps();
    expect(warn).toHaveBeenCalledOnce();

    value = 'Worse!';
    isAppDisabled('mail');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('hands out a list a caller can change without changing the next answer', () => {
    const apps = disabledApps();
    apps.push('notes');
    apps.length = 0;

    expect(isAppDisabled('mail')).toBe(true);
    expect(isAppDisabled('notes')).toBe(false);
    expect(disabledApps()).toEqual(['mail']);
  });
});
