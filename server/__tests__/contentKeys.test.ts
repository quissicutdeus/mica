// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
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

import { USAGE, defaultKid, keygenSteps, runContentKeysCommand } from '../services/ContentKeys';
import { parseKeyring, resetContentCipherForTests } from '../lib/contentCipher';

const dir = mkdtempSync(join(tmpdir(), 'mica-micacrypt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let logged: string[] = [];
let errors: string[] = [];

/** Every file and directory under `root`, relative: what keygen must leave as it found it. */
const tree = (root: string): string[] => readdirSync(root, { recursive: true }).map(String).sort();

beforeEach(() => {
  logged = [];
  errors = [];
  gate.hold = null;
  (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
  delete (globalThis as any).GetResourcePath;
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

  it('refuses anyone but the server console, before touching the database or the console', async () => {
    for (const args of [['status'], ['backfill', '--apply'], ['keygen', 'k1']]) {
      await runContentKeysCommand(7, args);
    }
    expect(notifyPlayer).toHaveBeenCalledTimes(3);
    expect(notifyPlayer.mock.calls[0]).toEqual([
      7,
      expect.objectContaining({ type: 'error', key: 'server.schema.noPermission' })
    ]);
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
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
    [['keygen', 'k1', 'k2']],
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
      'micacrypt keygen [kid]'
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

describe('keygen (MICA-303): prints the steps, writes nothing, prints no key', () => {
  /** A server-data with micaOS at `resources/[local]/mica`, as FXServer would report it. */
  const serverData = (): string => {
    const root = mkdtempSync(join(dir, 'sd-'));
    mkdirSync(join(root, 'resources', '[local]', 'mica'), { recursive: true });
    (globalThis as any).GetResourcePath = (name: string) =>
      name === 'mica' ? join(root, 'resources', '[local]', 'mica') : '';
    return root;
  };

  /** Anything in the output shaped like a key: base64 of 32 bytes is 43 characters and a '='. */
  const KEY_SHAPE = /[A-Za-z0-9+/]{43}=/;

  it('prints the openssl line, the mica-keys resource and the server.cfg line', async () => {
    const root = serverData();
    const before = tree(dir);
    await runContentKeysCommand(0, ['keygen', 'k1']);

    const file = `${root}/resources/[local]/mica-keys/mica-content.key`;
    expect(logged).toEqual(keygenSteps('k1', root));
    const out = logged.join('\n');
    expect(out).toContain(`mkdir -p "${root}/resources/[local]/mica-keys"`);
    expect(out).toContain("      fx_version 'cerulean'\n[micacrypt]      game 'common'\n");
    expect(out).toContain(
      `(umask 077; set -C; printf '%s %s\\n' "k1" "$(openssl rand -base64 32)" > "${file}")`
    );
    expect(out).toContain(`set mica_content_key_file "${file}"`);
    expect(out).toContain('never setr');
    expect(out).toContain('symlink');
    expect(out).toContain('adjust if your resources live elsewhere');
    expect(out).toContain('micacrypt backfill --apply');
    expect(errors).toEqual([]);

    // Nothing written anywhere under the test's directory, which holds that server-data.
    expect(tree(dir)).toEqual(before);
    expect(out).not.toMatch(KEY_SHAPE);
  });

  it("takes server-data from the server's start directory when micaOS is not under resources/", async () => {
    (globalThis as any).GetResourcePath = () => '/opt/mica';
    await runContentKeysCommand(0, ['keygen', 'k1']);
    expect(logged.join('\n')).toContain(
      `set mica_content_key_file "${process.cwd()}/resources/[local]/mica-keys/mica-content.key"`
    );
  });

  it('names the key after the date and minute when no id is given', async () => {
    serverData();
    await runContentKeysCommand(0, ['keygen']);
    expect(logged.join('\n')).toMatch(/printf '%s %s\\n' "k\d{8}-\d{4}" /);
    // Two the same day differ, and each is a legal id.
    const morning = defaultKid(new Date(Date.UTC(2026, 8, 29, 9, 5)));
    const evening = defaultKid(new Date(Date.UTC(2026, 8, 29, 18, 24)));
    expect([morning, evening]).toEqual(['k20260929-0905', 'k20260929-1824']);
    for (const kid of [morning, evening]) expect(kid).toMatch(/^[a-z0-9-]{1,16}$/);
  });

  it('refuses a bad id, and says a path is no longer taken', async () => {
    const before = tree(dir);
    await runContentKeysCommand(0, ['keygen', 'Bad-Id']);
    await runContentKeysCommand(0, ['keygen', join(dir, 'old-style.key')]);
    expect(logged).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("keygen refused: the key id 'Bad-Id' is not 1-16 of a-z");
    expect(errors[0]).not.toContain('takes no path');
    expect(errors[1]).toContain('keygen takes no path: it writes nothing');
    expect(tree(dir)).toEqual(before);
  });

  it('refuses an id the loaded key file already holds, and prints no steps', async () => {
    const live = join(dir, 'live.key');
    writeFileSync(live, `k1 ${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_content_key_file' ? live : fallback;
    resetContentCipherForTests();

    await runContentKeysCommand(0, ['keygen', 'k1']);
    expect(logged).toEqual([]);
    expect(errors.join('\n')).toContain("the key id 'k1' is already in the loaded key file");

    await runContentKeysCommand(0, ['keygen', 'k2']);
    expect(logged.join('\n')).toContain('"k2"');
  });

  it('prints shell steps that write a keyring micaOS reads, mode 600, never over one', () => {
    const root = mkdtempSync(join(dir, 'shell-'));
    const lines = keygenSteps('k9', root).map((line) => line.replace(/^\[micacrypt\]\s*/, ''));
    const mkdir = lines.find((line) => line.startsWith('mkdir -p '));
    const write = lines.find((line) => line.startsWith('(umask 077;'));
    if (!mkdir || !write) throw new Error(`keygen printed no shell steps: ${lines.join(' | ')}`);
    const file = `${root}/resources/[local]/mica-keys/mica-content.key`;

    // Needs `sh` and `openssl` on the machine running the suite, as the owner's server does.
    execFileSync('sh', ['-c', `${mkdir} && ${write}`]);
    const text = readFileSync(file, 'utf8');
    expect(parseKeyring(text).map((key) => key.kid)).toEqual(['k9']);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Run again: noclobber refuses, and the first key is still the one there.
    expect(() => execFileSync('sh', ['-c', write], { stdio: 'pipe' })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
});
