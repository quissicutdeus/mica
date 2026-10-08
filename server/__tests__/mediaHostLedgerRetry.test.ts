// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-328: a failed write of the image-host ledger is retried, not remembered as done.
 *
 * `rememberImageHost` marked a host persisted before its INSERT ran, and the catch only
 * warned. A ledger unwritable at start (`micaschema apply` not yet run) therefore never got
 * the host until a restart — and an owner who changed `mica_media_image_host` before that
 * restart had every photo on the old host stop counting, never cleaned.
 *
 * Imports `mediaHost` alone, so nothing here depends on how `Media.ts` is laid out. The
 * `Database` mock is inspected, never run.
 */
const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { recordedImageHosts, rememberImageHost, resetMediaHostForTests } from '../lib/mediaHost';

const LEDGER_WRITE = 'INSERT IGNORE INTO `mica_schema_migrations`';

const ledgerWrites = (): unknown[][] =>
  dbMock.query.mock.calls.filter((call: unknown[]) => String(call[0]).startsWith(LEDGER_WRITE));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetMediaHostForTests();
  dbMock.query.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('rememberImageHost when the ledger write fails', () => {
  it('tries again on the next occasion, and stops once a write succeeds', async () => {
    dbMock.query.mockRejectedValueOnce(new Error("Table 'mica_schema_migrations' doesn't exist"));
    dbMock.query.mockResolvedValue({ affectedRows: 1 });

    await rememberImageHost('img.example.test'); // at start: the ledger is not there yet
    await rememberImageHost('img.example.test'); // the next upload, after micaschema apply
    await rememberImageHost('img.example.test'); // written now: no further statement

    expect(ledgerWrites()).toHaveLength(2);
    expect(ledgerWrites()[1][1]).toEqual(['mediahost:img.example.test']);
    // The failure is said once, not once per retry.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/run micaschema apply/);
  });

  it('keeps retrying while the ledger stays unwritable', async () => {
    dbMock.query.mockRejectedValue(new Error('no ledger'));

    await rememberImageHost('img.example.test');
    await rememberImageHost('img.example.test');
    await rememberImageHost('img.example.test');

    expect(ledgerWrites()).toHaveLength(3);
  });

  it('still counts the host in this process while the write fails', async () => {
    dbMock.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith(LEDGER_WRITE)) throw new Error('no ledger');
      return [];
    });

    await rememberImageHost('img.example.test');

    expect([...(await recordedImageHosts())]).toContain('img.example.test');
  });

  it('names each failing host, not only the first', async () => {
    dbMock.query.mockRejectedValue(new Error('no ledger'));

    await rememberImageHost('img.example.test');
    await rememberImageHost('cdn.example.test');
    await rememberImageHost('img.example.test');

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('img.example.test');
    expect(String(warn.mock.calls[1][0])).toContain('cdn.example.test');
  });

  it('sends one statement for concurrent calls while a write is in flight', async () => {
    let finish: (value: unknown) => void = () => {};
    dbMock.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );

    const first = rememberImageHost('img.example.test');
    const second = rememberImageHost('img.example.test');
    finish({ affectedRows: 1 });
    await Promise.all([first, second]);

    expect(ledgerWrites()).toHaveLength(1);
  });
});

describe('rememberImageHost for a host too long for the ledger', () => {
  // A valid DNS name (labels of 61, total 247) whose marker, `mediahost:` + host, is 257.
  const LONG = Array.from({ length: 4 }, (_, i) => `${'a'.repeat(60)}${i}`).join('.');

  it('writes nothing, says once that its photos will not be tracked, and never names it', async () => {
    expect(LONG).toHaveLength(247);
    dbMock.query.mockResolvedValue({ affectedRows: 1 });

    await rememberImageHost(LONG);
    await rememberImageHost(LONG);

    expect(ledgerWrites()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/247 characters is too long to record/);
    expect(line).toMatch(/not tracked once mica_media_image_host points elsewhere/);
    expect(line).not.toContain(LONG);
  });
});
