// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * MICA-165: the `micacrypt` console command — who may run it, what it parses, and what it
 * prints. The walk itself is `contentBackfill.test.ts`'s; here it runs over an empty registry
 * and a database stub that counts what it is asked.
 */
const { dbMock, notifyPlayer, commands, gate } = vi.hoisted(() => {
  const registered = new Map<string, Function>();
  const previous = (globalThis as any).RegisterCommand;
  (globalThis as any).RegisterCommand = (name: string, handler: Function, restricted: boolean) => {
    registered.set(name, handler);
    return typeof previous === 'function' ? previous(name, handler, restricted) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), update: vi.fn(), scalar: vi.fn(), insert: vi.fn() },
    notifyPlayer: vi.fn(),
    commands: registered,
    /** While set, the notification count waits on it: a run held open mid-way. */
    gate: { hold: null as null | Promise<void> }
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/shell', () => ({ notifyPlayer }));

import { USAGE, defaultKid, runContentKeysCommand } from '../services/ContentKeys';
import { resetContentCipherForTests } from '../lib/contentCipher';

const dir = mkdtempSync(join(tmpdir(), 'mica-micacrypt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let logged: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  logged = [];
  errors = [];
  gate.hold = null;
  (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
  resetContentCipherForTests();
  notifyPlayer.mockReset();
  dbMock.query.mockReset();
  dbMock.update.mockReset();
  dbMock.query.mockImplementation(async (sql: string) => {
    if (gate.hold) await gate.hold;
    if (sql.includes('FROM `mica_notifications`')) return [{ n: 3 }];
    return [];
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('who may run micacrypt', () => {
  it('registers the command', () => {
    expect(commands.has('micacrypt')).toBe(true);
  });

  it('refuses anyone but the server console, before touching the database or a file', async () => {
    const path = join(dir, 'from-a-player');
    for (const args of [['status'], ['backfill', '--apply'], ['keygen', path]]) {
      await runContentKeysCommand(7, args);
    }
    expect(notifyPlayer).toHaveBeenCalledTimes(3);
    expect(notifyPlayer.mock.calls[0]).toEqual([
      7,
      expect.objectContaining({ type: 'error', key: 'server.schema.noPermission' })
    ]);
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });
});

describe('arguments', () => {
  it.each([
    [[]],
    [['wat']],
    [['status', 'extra']],
    [['backfill', '--wat']],
    [['backfill', '--batch']],
    [['backfill', '--batch', '0']],
    [['backfill', '--batch', '5001']],
    [['backfill', '--batch', 'many']],
    [['keygen']],
    [['keygen', '/a', 'b', 'c']]
  ])('prints usage for %j and does nothing', async (args) => {
    await runContentKeysCommand(0, args);
    expect(logged).toEqual(USAGE);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('shows the usage lines the docs carry', () => {
    expect(USAGE.slice(1).map((line) => line.replace('[micacrypt]', '').trim())).toEqual([
      'micacrypt status',
      'micacrypt backfill [--apply] [--batch N]   (N from 1 to 5000, default 500)',
      'micacrypt keygen <absolute path> [kid]'
    ]);
  });
});

describe('status and backfill', () => {
  it('status reports the registry and the DM notifications still holding a body', async () => {
    await runContentKeysCommand(0, ['status']);
    expect(logged).toEqual([
      '[micacrypt] no content key is set; new bodies are stored as plaintext.',
      '[micacrypt] no encrypted column is registered.',
      '[micacrypt] DM notifications still holding a body: 3.'
    ]);
    // The add-on's app id comes from this service, not from core.
    const counted = dbMock.query.mock.calls.find((c) =>
      String(c[0]).includes('COUNT(*) AS `n` FROM `mica_notifications`')
    );
    expect(counted?.[1]).toEqual(['blabber', 'dm']);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('backfill without --apply is a dry run and writes nothing', async () => {
    await runContentKeysCommand(0, ['backfill', '--batch', '50']);
    expect(logged[0]).toContain('backfill dry run (nothing written; add --apply)');
    expect(logged.at(-1)).toBe('[micacrypt] DM notification bodies that would be blanked: 3.');
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.query.mock.calls.some((c) => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });

  it('backfill --apply without a key refuses loudly and reads nothing', async () => {
    await runContentKeysCommand(0, ['backfill', '--apply']);
    expect(errors.join('\n')).toContain('backfill --apply refused: no content key is loaded');
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('runs one at a time', async () => {
    let release!: () => void;
    gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = runContentKeysCommand(0, ['status']);
    await runContentKeysCommand(0, ['backfill']);
    expect(logged).toEqual([
      '[micacrypt] a status or backfill is already running; wait for it to finish.'
    ]);
    release();
    await first;
    // And the flag is down again afterwards.
    logged = [];
    gate.hold = null;
    await runContentKeysCommand(0, ['status']);
    expect(logged.at(-1)).toBe('[micacrypt] DM notifications still holding a body: 3.');
  });

  it('says a failed run failed, and frees the command for the next', async () => {
    dbMock.query.mockRejectedValueOnce(new Error('connection lost'));
    await runContentKeysCommand(0, ['status']);
    expect(errors.join('\n')).toContain('status failed part-way');
    dbMock.query.mockImplementation(async () => [{ n: 0 }]);
    await runContentKeysCommand(0, ['status']);
    expect(logged.at(-1)).toBe('[micacrypt] DM notifications still holding a body: 0.');
  });
});

describe('keygen', () => {
  it('writes a key file 0600 and prints the server.cfg line and the warnings', async () => {
    const path = join(dir, 'content.key');
    await runContentKeysCommand(0, ['keygen', path, 'k1']);

    expect(readFileSync(path, 'utf8')).toMatch(/^k1 [A-Za-z0-9+/]{43}=$/m);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const out = logged.join('\n');
    expect(out).toContain(`wrote a new key 'k1' to ${path}`);
    expect(out).toContain(`set mica_content_key_file "${path}"`);
    expect(out).toContain('never setr');
    expect(out).toContain('outside the database backup and out of git');
  });

  it('names the key after the date and minute when no id is given', async () => {
    const path = join(dir, 'dated.key');
    await runContentKeysCommand(0, ['keygen', path]);
    expect(readFileSync(path, 'utf8')).toMatch(/^k\d{8}-\d{4} /m);
    // Two the same day differ, and each is a legal id.
    const morning = defaultKid(new Date(Date.UTC(2026, 8, 29, 9, 5)));
    const evening = defaultKid(new Date(Date.UTC(2026, 8, 29, 18, 24)));
    expect([morning, evening]).toEqual(['k20260929-0905', 'k20260929-1824']);
    for (const kid of [morning, evening]) expect(kid).toMatch(/^[a-z0-9-]{1,16}$/);
  });

  it('refuses an id the loaded key file already holds, and writes nothing', async () => {
    const live = join(dir, 'live.key');
    writeFileSync(live, `k1 ${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_content_key_file' ? live : fallback;
    resetContentCipherForTests();

    const path = join(dir, 'second.key');
    await runContentKeysCommand(0, ['keygen', path, 'k1']);

    expect(existsSync(path)).toBe(false);
    expect(errors.join('\n')).toContain("the key id 'k1' is already in the loaded key file");
    await runContentKeysCommand(0, ['keygen', path, 'k2']);
    expect(existsSync(path)).toBe(true);
  });

  it('never overwrites a key file, and refuses a relative path', async () => {
    const path = join(dir, 'existing.key');
    writeFileSync(path, 'k0 keep-me\n');
    await runContentKeysCommand(0, ['keygen', path, 'k1']);
    await runContentKeysCommand(0, ['keygen', 'relative.key', 'k1']);

    expect(readFileSync(path, 'utf8')).toBe('k0 keep-me\n');
    expect(existsSync('relative.key')).toBe(false);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('keygen refused');
    expect(errors[0]).toContain('never overwritten');
    expect(errors[1]).toContain('not an absolute path');
  });
});
