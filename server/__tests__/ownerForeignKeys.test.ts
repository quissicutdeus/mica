// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  dropOwnerForeignKeys,
  ownerForeignKeys,
  reportOwnerForeignKeys
} from '../lib/ownerForeignKeys';

/**
 * MICA-300, from review: the keys onto `players` are asked of `information_schema` every time,
 * never inferred from the migrations ledger, which a re-imported `mica.sql` marks as done while
 * the old tables keep their keys. `pnpm test:migrations` runs that re-import for real.
 */
const isLookup = (sql: string) => sql.includes('information_schema.REFERENTIAL_CONSTRAINTS');
const drops = (): string[] =>
  dbMock.query.mock.calls.map((c: any[]) => String(c[0])).filter((sql) => !isLookup(sql));
const withKeys = (keys: unknown) =>
  dbMock.query.mockImplementation(async (sql: string) => (isLookup(sql) ? keys : []));

const KEYS = [
  { table: 'mica_audit_logs', name: 'fk_audit_logs_citizenid' },
  { table: 'mica_notes', name: 'restored_by_hand' }
];

let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
});
afterEach(() => {
  errors.mockRestore();
  warnings.mockRestore();
  (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
});

describe('ownerForeignKeys', () => {
  it('finds keys by what they reference, on micaOS tables only, in this schema', async () => {
    withKeys([]);
    await ownerForeignKeys();

    const [sql, params] = dbMock.query.mock.calls[0];
    expect(String(sql)).toContain('CONSTRAINT_SCHEMA = DATABASE()');
    expect(String(sql)).toContain('REFERENCED_TABLE_NAME = ?');
    expect(String(sql)).toContain("TABLE_NAME LIKE 'mica\\_%'");
    expect(params).toEqual(['players']);
  });

  it.each([
    ['an answer that is not a list', { affectedRows: 0 }, /did not answer/],
    ['a row without a name', [{ table: 'mica_notes' }], /without a table or a name/],
    ['a name it would have to quote', [{ table: 'mica_notes', name: 'x`; --' }], /plain name/]
  ])('throws on %s, never reading it as none', async (_label, answer, error) => {
    withKeys(answer);
    await expect(ownerForeignKeys()).rejects.toThrow(error);
  });
});

describe('dropOwnerForeignKeys, the standing step of micaschema apply', () => {
  it('drops each key it finds and answers how many', async () => {
    withKeys(KEYS);

    expect(await dropOwnerForeignKeys()).toBe(2);
    expect(drops()).toEqual([
      'ALTER TABLE `mica_audit_logs` DROP FOREIGN KEY `fk_audit_logs_citizenid`',
      'ALTER TABLE `mica_notes` DROP FOREIGN KEY `restored_by_hand`'
    ]);
  });

  it('drops nothing where there are none', async () => {
    withKeys([]);
    expect(await dropOwnerForeignKeys()).toBe(0);
    expect(drops()).toEqual([]);
  });

  it('refuses before dropping anything when one name is not plain', async () => {
    withKeys([...KEYS, { table: 'mica_notes', name: 'x` ; DROP TABLE players; --' }]);
    await expect(dropOwnerForeignKeys()).rejects.toThrow(/plain name/);
    expect(drops()).toEqual([]);
  });
});

describe('reportOwnerForeignKeys, at every start', () => {
  const said = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('is quiet when there are none', async () => {
    withKeys([]);
    expect(await reportOwnerForeignKeys()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('says the count, the tables and the remedy as an error, image host or not', async () => {
    withKeys(KEYS);

    expect(await reportOwnerForeignKeys()).toBe(2);
    const line = said(errors);
    expect(line).toContain('2 foreign key(s) from micaOS tables onto players');
    expect(line).toContain('mica_audit_logs, mica_notes');
    expect(line).toContain('Run micaschema apply');
    expect(line).not.toContain('hosted photos');
    expect(drops()).toEqual([]);
  });

  it('says what the cascade does to hosted photos when there is an image host', async () => {
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_media_image_host' ? 'img.example.test' : fallback;
    withKeys(KEYS);

    await reportOwnerForeignKeys();
    expect(said(errors)).toContain('hosted photos stay on img.example.test');
  });

  it('says it could not check, rather than reading a failure as none', async () => {
    dbMock.query.mockRejectedValue(new Error('denied'));

    expect(await reportOwnerForeignKeys()).toBeNull();
    expect(said(warnings)).toContain('could not check for foreign keys onto players');
  });
});
