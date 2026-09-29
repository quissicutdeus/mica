// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * MICA-165: the content cipher. `Database` is a stub answering only the enabled-marker
 * bookkeeping; the key file is a real file in a temporary directory, read through a stubbed
 * `mica_content_key_file` convar.
 */
const { dbMock, startHandlers } = vi.hoisted(() => {
  const starts: Function[] = [];
  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    if (event === 'onResourceStart') starts.push(handler);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };
  return { dbMock: { query: vi.fn() }, startHandlers: starts };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  CONTENT_CIPHER_MARKER_ID,
  KeyringError,
  SEALED_PREFIX,
  UNREADABLE_CONTENT,
  activeKeyId,
  announceContentCipher,
  contentContext,
  contextColumns,
  encryptedColumn,
  encryptedColumns,
  encryptedColumnsOf,
  isSealed,
  keyFileWarnings,
  loadedKeyIds,
  maxPlaintextChars,
  onContentCipherResourceStart,
  openContent,
  openRow,
  openRows,
  parseKeyring,
  registerEncryptedColumn,
  resetContentCipherForTests,
  sealContent,
  sealedKeyId,
  sealedLength,
  sealedLengthForChars,
  sealRow,
  tryOpenContent,
  storablePlaintext,
  unregisterEncryptedColumnForTests,
  writeNewKeyFile,
  type ContentContext
} from '../lib/contentCipher';
import { PlayerFacingError } from '../lib/errors';

const dir = mkdtempSync(join(tmpdir(), 'mica-content-key-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const b64 = (bytes = 32): string => randomBytes(bytes).toString('base64');

let fileCount = 0;
/** A key file with these lines, mode 0600 unless said otherwise. */
const keyFile = (lines: string[], mode = 0o600): string => {
  fileCount += 1;
  const path = join(dir, `keys-${fileCount}`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  chmodSync(path, mode);
  return path;
};

let convar = '';
const useKeyFile = (path: string): void => {
  convar = path;
};

/**
 * The ledger as the stub sees it: whether it exists, whether the marker is in it, and whether
 * writing the marker fails.
 */
let ledger = {
  exists: true,
  marker: false,
  failWrite: false,
  width: 65535 as number | 'unknown'
};
const inserts: unknown[][] = [];

beforeEach(() => {
  convar = '';
  ledger = { exists: true, marker: false, failWrite: false, width: 65535 };
  inserts.length = 0;
  resetContentCipherForTests();
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_content_key_file' ? convar : fallback;
  dbMock.query.mockReset();
  dbMock.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('information_schema.TABLES')) return [{ n: ledger.exists ? 1 : 0 }];
    if (sql.includes('information_schema.COLUMNS')) {
      if (ledger.width === 'unknown') throw new Error('no answer');
      return [{ chars: ledger.width, bytes: ledger.width * 4 }];
    }
    if (sql.startsWith('SELECT COUNT(*)')) return [{ n: ledger.marker ? 1 : 0 }];
    if (sql.startsWith('INSERT IGNORE')) {
      if (ledger.failWrite) throw new Error("Table 'mica_schema_migrations' doesn't exist");
      inserts.push(params);
      ledger.marker = true;
      return { affectedRows: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const message = (over: Partial<ContentContext> = {}): ContentContext => ({
  table: 'mica_messages',
  column: 'message',
  citizenid: 'ABC123',
  scope: [7],
  ...over
});

describe('sizes', () => {
  it('computes the sealed width of a bound in bytes and in characters', () => {
    // '$mc1$' + 16-char kid + '$' + base64(12 + n + 16).
    expect(sealedLength(0)).toBe(22 + 40);
    expect(sealedLengthForChars(500)).toBe(2726);
    expect(sealedLengthForChars(300)).toBe(1662);
  });

  it('finds the most characters whose worst case fits a text column, and not one more', () => {
    const chars = maxPlaintextChars(65535);
    expect(chars).toBe(12276);
    expect(sealedLengthForChars(chars)).toBeLessThanOrEqual(65535);
    expect(sealedLengthForChars(chars + 1)).toBeGreaterThan(65535);
    for (const capacity of [100, 255, 1000, 2726, 16777215]) {
      const c = maxPlaintextChars(capacity);
      expect(sealedLengthForChars(c)).toBeLessThanOrEqual(capacity);
      expect(sealedLengthForChars(c + 1)).toBeGreaterThan(capacity);
    }
  });

  it('holds in practice: a worst-case plaintext under the longest kid is exactly the bound', async () => {
    useKeyFile(keyFile([`k234567890123456 ${b64()}`]));
    // 500 four-byte characters: 2,000 bytes, the most a varchar(500) of utf8mb4 holds.
    const dm = await sealContent(message(), '\u{1F600}'.repeat(500));
    expect(dm.length).toBe(sealedLengthForChars(500));
    const text = await sealContent(message(), '\u{1F600}'.repeat(12276));
    expect(text.length).toBe(sealedLengthForChars(12276));
    expect(text.length).toBeLessThanOrEqual(65535);
  });
});

describe('the sealed form', () => {
  it('recognises the prefix and reads the key id', () => {
    expect(isSealed('$mc1$k1$AAAA')).toBe(true);
    expect(isSealed('hello')).toBe(false);
    expect(isSealed(null)).toBe(false);
    expect(sealedKeyId('$mc1$k1$AAAA')).toBe('k1');
    expect(sealedKeyId('$mc1$BAD$AAAA')).toBeNull();
    expect(sealedKeyId('plain')).toBeNull();
  });

  it('never starts with mica:, which the event-name scan would read as an event', () => {
    expect(SEALED_PREFIX.startsWith('mica:')).toBe(false);
  });
});

describe('parseKeyring', () => {
  it('reads keys in order, skipping comments and blank lines; the first is active', () => {
    const keys = parseKeyring(['# comment', '', `new ${b64()}`, '  ', `old-1 ${b64()}`].join('\n'));
    expect(keys.map((k) => k.kid)).toEqual(['new', 'old-1']);
    expect(keys[0].key.length).toBe(32);
  });

  it.each([
    ['a bad kid', `Upper ${b64()}`],
    ['a kid too long', `k2345678901234567 ${b64()}`],
    ['a short key', `k1 ${b64(16)}`],
    ['a long key', `k1 ${b64(33)}`],
    ['not base64', 'k1 !!!!notbase64!!!!notbase64!!!!notbase64!!'],
    ['three fields', `k1 ${b64()} extra`],
    ['one field', 'k1'],
    ['a repeated kid', `k1 ${b64()}\nk1 ${b64()}`],
    ['no key at all', '# nothing here\n\n']
  ])('refuses %s', (_label, text) => {
    expect(() => parseKeyring(text)).toThrow(KeyringError);
  });

  it('never repeats key material in a refusal', () => {
    const secret = b64(31);
    try {
      parseKeyring(`k1 ${secret}`);
      throw new Error('did not refuse');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe('seal and open with a key', () => {
  beforeEach(() => useKeyFile(keyFile([`k1 ${b64()}`, `k0 ${b64()}`])));

  it('round-trips, with a fresh IV each time, under the first key', async () => {
    const a = await sealContent(message(), 'meet at the pier');
    const b = await sealContent(message(), 'meet at the pier');
    expect(a.startsWith('$mc1$k1$')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('pier');
    expect(openContent(message(), a)).toBe('meet at the pier');
    expect(activeKeyId()).toBe('k1');
    expect(loadedKeyIds()).toEqual(['k1', 'k0']);
  });

  it('round-trips the empty string and multi-byte text', async () => {
    expect(openContent(message(), await sealContent(message(), ''))).toBe('');
    const text = 'Grüße \u{1F600} 你好';
    expect(openContent(message(), await sealContent(message(), text))).toBe(text);
  });

  it('records the enabled marker before the first sealed value is handed back, once', async () => {
    await sealContent(message(), 'one');
    await sealContent(message(), 'two');
    expect(inserts).toEqual([[CONTENT_CIPHER_MARKER_ID]]);
  });

  it('refuses to seal when the marker cannot be recorded', async () => {
    ledger.failWrite = true;
    await expect(sealContent(message(), 'hello')).rejects.toThrow(/marker/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('micaschema apply'));
  });

  it.each([
    ['another citizenid', message({ citizenid: 'XYZ999' })],
    ['another conversation', message({ scope: [8] })],
    ['another column', message({ column: 'body' })],
    ['another table', message({ table: 'mica_mail' })]
  ])('will not open under %s: a padlock, not an error', async (_label, elsewhere) => {
    const sealed = await sealContent(message(), 'secret');
    expect(openContent(elsewhere, sealed, 41)).toBe(UNREADABLE_CONTENT);
  });

  it('binds null and missing scope values distinctly from a string', async () => {
    const withNull = message({ scope: [null] });
    const sealed = await sealContent(withNull, 'x');
    expect(openContent(withNull, sealed)).toBe('x');
    expect(openContent(message({ scope: ['null'] }), sealed)).toBe(UNREADABLE_CONTENT);
  });

  it('logs an unreadable row once per table and id', async () => {
    const sealed = await sealContent(message(), 'secret');
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    openContent(message({ scope: [9] }), sealed, 5);
    openContent(message({ scope: [9] }), sealed, 5);
    openContent(message({ scope: [9] }), sealed, 6);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).not.toContain('secret');
  });

  it('shows a padlock for an unknown key id, a tampered payload and a malformed one', async () => {
    const sealed = await sealContent(message(), 'secret');
    expect(openContent(message(), sealed.replace('$mc1$k1$', '$mc1$k9$'))).toBe(UNREADABLE_CONTENT);
    const body = sealed.slice('$mc1$k1$'.length);
    const flipped = (body[10] === 'A' ? 'B' : 'A') + '';
    const tampered = `$mc1$k1$${body.slice(0, 10)}${flipped}${body.slice(11)}`;
    expect(openContent(message(), tampered)).toBe(UNREADABLE_CONTENT);
    expect(openContent(message(), '$mc1$k1$***')).toBe(UNREADABLE_CONTENT);
    expect(openContent(message(), '$mc1$k1$AAAA')).toBe(UNREADABLE_CONTENT);
    expect(openContent(message(), '$mc1$nodelimiter')).toBe(UNREADABLE_CONTENT);
  });

  it('opens a value sealed with an older key still in the ring', async () => {
    const older = await sealContent(message(), 'from before');
    const oldLine = readFileSync(convar, 'utf8').split('\n')[0];
    resetContentCipherForTests();
    useKeyFile(keyFile([`k2 ${b64()}`, oldLine]));
    expect(openContent(message(), older)).toBe('from before');
    expect((await sealContent(message(), 'now')).startsWith('$mc1$k2$')).toBe(true);
  });

  const widthProbes = () =>
    dbMock.query.mock.calls.filter(([sql]) => String(sql).includes('information_schema.COLUMNS'))
      .length;

  it('refuses a sealed value too long for its live column, loudly', async () => {
    ledger.width = 500; // mica_blabber_dms.body before migration 0007
    // 480 characters fit a varchar(500) as plaintext; their sealed form does not.
    await expect(sealContent(message(), 'x'.repeat(480))).rejects.toThrow(/too narrow/);
    await expect(sealContent(message(), 'y'.repeat(480))).rejects.toThrow(/too narrow/);
    expect(await sealContent(message(), 'short')).toMatch(/^\$mc1\$k1\$/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('micaschema apply'));
  });

  it('records no enabled marker for a write it refused as too narrow', async () => {
    ledger.width = 500;
    await expect(sealContent(message(), 'x'.repeat(480))).rejects.toThrow(/too narrow/);
    expect(inserts).toEqual([]);
    expect(ledger.marker).toBe(false);

    // Take the key away: nothing was ever stored sealed, so writes are still plaintext.
    resetContentCipherForTests();
    convar = '';
    expect(await sealContent(message(), 'plain')).toBe('plain');
  });

  it('sees micaschema apply widen the column without a restart', async () => {
    ledger.width = 500;
    await expect(sealContent(message(), 'x'.repeat(480))).rejects.toThrow(/too narrow/);
    await expect(sealContent(message(), 'x'.repeat(480))).rejects.toThrow(/too narrow/);
    expect(widthProbes()).toBe(2); // a narrow answer is asked again, not believed

    ledger.width = 2726; // the apply ran on the live server
    expect(isSealed(await sealContent(message(), 'x'.repeat(480)))).toBe(true);
    expect(widthProbes()).toBe(3);

    // A width that fits is kept: no more probes for this column.
    await sealContent(message(), 'x'.repeat(480));
    await sealContent(message(), 'again');
    expect(widthProbes()).toBe(3);
  });

  it('writes through when the width cannot be read, but never believes that for long', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    ledger.width = 'unknown';
    const error = console.error as unknown as ReturnType<typeof vi.fn>;

    expect(isSealed(await sealContent(message(), 'hello'))).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not read the width'));
    expect(widthProbes()).toBe(1);

    // Inside the minute: not asked again, not said again.
    now += 30_000;
    await sealContent(message(), 'again');
    expect(widthProbes()).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);

    // Past it: asked again, and said again while it still will not answer.
    now += 31_000;
    await sealContent(message(), 'again');
    expect(widthProbes()).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);

    // The database answers at last, and the fit check is on: a narrow column refuses.
    now += 61_000;
    ledger.width = 500;
    await expect(sealContent(message(), 'x'.repeat(480))).rejects.toThrow(/too narrow/);
    expect(widthProbes()).toBe(3);
  });

  it('tells a failed open from a body that is literally the padlock, quietly', async () => {
    const padlock = await sealContent(message(), UNREADABLE_CONTENT);
    const other = await sealContent(message({ scope: [99] }), 'elsewhere');
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();

    expect(tryOpenContent(message(), padlock)).toBe(UNREADABLE_CONTENT);
    expect(tryOpenContent(message(), other)).toBeNull();
    expect(tryOpenContent(message(), other.replace('$mc1$k1$', '$mc1$k9$'))).toBeNull();
    expect(tryOpenContent(message(), '$mc1$k1$***')).toBeNull();
    expect(tryOpenContent(message(), 'legacy')).toBe('legacy');
    expect(warn).not.toHaveBeenCalled();

    // The reader's form cannot tell the two apart, which is why the other exists.
    expect(openContent(message(), padlock)).toBe(UNREADABLE_CONTENT);
    expect(openContent(message(), other, 3)).toBe(UNREADABLE_CONTENT);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('passes legacy plaintext through unchanged', () => {
    expect(openContent(message(), 'written before MICA-165')).toBe('written before MICA-165');
  });

  it('keeps a known narrow width when asking again fails, so the check stays on', async () => {
    ledger.width = 500;
    await expect(sealContent(message(), 'x'.repeat(480))).rejects.toThrow(/too narrow/);
    ledger.width = 'unknown'; // the database stops answering
    await expect(sealContent(message(), 'x'.repeat(480))).rejects.toThrow(/too narrow/);
    expect(await sealContent(message(), 'short')).toMatch(/^\$mc1\$k1\$/);
  });

  it('seals a value that already looks sealed, and opens it back to exactly that text', async () => {
    for (const text of ['$mc1$k1$AAAA', `$mc1$k1$${'A'.repeat(40)}`, '$mc1$']) {
      const sealed = await sealContent(message(), text);
      expect(sealed).not.toBe(text);
      expect(openContent(message(), sealed)).toBe(text);
      expect(tryOpenContent(message(), sealed)).toBe(text);
    }
  });

  it('leaves a sealed-looking text alone for storage, since it will be sealed', async () => {
    expect(await storablePlaintext('$mc1$k1$AAAA')).toBe('$mc1$k1$AAAA');
  });
});

describe('without a key', () => {
  it('stores plaintext while nothing has ever been sealed', async () => {
    expect(await sealContent(message(), 'plain')).toBe('plain');
    expect(activeKeyId()).toBeNull();
    expect(inserts).toEqual([]);
  });

  it('stores plaintext when there is no ledger at all', async () => {
    ledger.exists = false;
    expect(await sealContent(message(), 'plain')).toBe('plain');
  });

  it('refuses every write once the database holds ciphertext, never falling back', async () => {
    ledger.marker = true;
    await expect(sealContent(message(), 'plain')).rejects.toThrow(/missing/);
    await expect(sealContent(message(), 'again')).rejects.toThrow(/missing/);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('reads sealed values as a padlock and plaintext as itself', () => {
    expect(openContent(message(), '$mc1$k1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(
      UNREADABLE_CONTENT
    );
    expect(openContent(message(), 'plain')).toBe('plain');
  });

  it('refuses a sealed-looking value it would store bare, as something a player can read', async () => {
    const refusal = await sealContent(message(), '$mc1$k1$AAAA').catch((error) => error);
    expect(refusal).toBeInstanceOf(PlayerFacingError);
    expect(refusal.key).toBe('server.content.reservedPrefix');
    expect(await sealContent(message(), 'contains $mc1$ later')).toBe('contains $mc1$ later');
  });

  it('holds a broken prefix to a bound, never cutting a character in half', async () => {
    expect(await storablePlaintext('$mc1$abc', 9)).toBe('​$mc1$abc');
    expect(await storablePlaintext('$mc1$abcd', 9)).toBe('​$mc1$abc');
    expect(await storablePlaintext('$mc1$ab\u{1F600}', 9)).toBe('​$mc1$ab');
    expect(await storablePlaintext('plain text', 3)).toBe('plain text');
  });

  it('breaks the prefix of a copied text it would store bare, so it stores as what it is', async () => {
    const stored = await storablePlaintext('$mc1$k1$AAAA');
    expect(stored).toBe('\u200B$mc1$k1$AAAA');
    expect(isSealed(stored)).toBe(false);
    expect(await sealContent(message(), stored)).toBe(stored);
    expect(await storablePlaintext('plain')).toBe('plain');
  });
});

describe('an unusable key file is never "no key"', () => {
  it.each([
    ['a relative path', () => 'keys/mica.key'],
    ['a missing file', () => join(dir, 'does-not-exist')],
    ['a malformed file', () => keyFile(['k1 not-a-key'])],
    ['an empty file', () => keyFile(['# only a comment'])]
  ])('%s refuses every seal, marker or not', async (_label, path) => {
    useKeyFile(path());
    await expect(sealContent(message(), 'plain')).rejects.toThrow(/unusable/);
    expect(activeKeyId()).toBeNull();
    expect(openContent(message(), 'plain')).toBe('plain');
  });
});

describe('where the key file lives', () => {
  it('warns when it is inside the resource, or inside server-data', () => {
    expect(
      keyFileWarnings('/srv/fx/server-data/resources/mica/key', {
        resourceRoot: '/srv/fx/server-data/resources/mica',
        serverData: '/srv/fx/server-data',
        mode: 0o100600
      })
    ).toEqual([expect.stringContaining('inside the resource folder')]);
    expect(
      keyFileWarnings('/srv/fx/server-data/mica.key', {
        resourceRoot: '/srv/fx/server-data/resources/mica',
        serverData: '/srv/fx/server-data',
        mode: 0o100600
      })
    ).toEqual([expect.stringContaining('inside server-data')]);
  });

  it('does not mistake a sibling directory with a shared prefix for the inside', () => {
    expect(
      keyFileWarnings('/srv/fx/server-data-keys/mica.key', {
        resourceRoot: null,
        serverData: '/srv/fx/server-data',
        mode: 0o100600
      })
    ).toEqual([]);
  });

  it('warns when group or world can read it, and says nothing about a 0600 file', () => {
    expect(
      keyFileWarnings('/etc/mica/key', { resourceRoot: null, serverData: null, mode: 0o100640 })
    ).toEqual([expect.stringContaining('chmod 600')]);
    expect(
      keyFileWarnings('/etc/mica/key', { resourceRoot: null, serverData: null, mode: 0o100600 })
    ).toEqual([]);
  });

  it('says so at load when the real file is group-readable, and still loads it', async () => {
    useKeyFile(keyFile([`k1 ${b64()}`], 0o644));
    expect(activeKeyId()).toBe('k1');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
  });
});

describe('writeNewKeyFile', () => {
  it('writes one fresh key, mode 0600, that the keyring reads back', () => {
    const path = join(dir, 'fresh.key');
    const result = writeNewKeyFile(path, 'k-2026');
    expect(result.path).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const keys = parseKeyring(readFileSync(path, 'utf8'));
    expect(keys.map((k) => k.kid)).toEqual(['k-2026']);
  });

  it('never overwrites, and refuses a relative path and a bad id', () => {
    const path = join(dir, 'kept.key');
    writeNewKeyFile(path, 'k1');
    const before = readFileSync(path, 'utf8');
    expect(() => writeNewKeyFile(path, 'k2')).toThrow(/already exists/);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(() => writeNewKeyFile('relative.key', 'k1')).toThrow(/absolute/);
    expect(() => writeNewKeyFile(join(dir, 'x.key'), 'Bad Id')).toThrow(KeyringError);
  });

  it('warns when written inside server-data', () => {
    const inside = join(process.cwd(), `.mica-key-test-${process.pid}`);
    try {
      const { warnings } = writeNewKeyFile(inside, 'k1');
      expect(warnings).toEqual([expect.stringContaining('inside server-data')]);
    } finally {
      rmSync(inside, { force: true });
    }
  });
});

describe('the registry and the context', () => {
  const entry = {
    table: 'test_threads',
    column: 'body',
    scope: ['thread_id', 'peer_id'],
    hasUpdatedAt: true
  };
  beforeEach(() => registerEncryptedColumn(entry));
  afterEach(() => unregisterEncryptedColumnForTests('test_threads', 'body'));

  it('lists what was registered, by table and by column', () => {
    expect(encryptedColumns()).toContainEqual(entry);
    expect(encryptedColumnsOf('test_threads')).toEqual([entry]);
    expect(encryptedColumnsOf('elsewhere')).toEqual([]);
    expect(encryptedColumn('test_threads', 'body')).toEqual(entry);
    expect(contextColumns(entry)).toEqual(['citizenid', 'thread_id', 'peer_id']);
  });

  it.each([
    ['a duplicate', entry],
    ['a bad identifier', { ...entry, column: 'Body;' }],
    ['citizenid in the scope', { ...entry, column: 'other', scope: ['citizenid'] }],
    ['the column in its own scope', { ...entry, column: 'other', scope: ['other'] }],
    ['a repeated scope column', { ...entry, column: 'other', scope: ['a', 'a'] }]
  ])('refuses %s', (_label, bad) => {
    expect(() => registerEncryptedColumn(bad)).toThrow();
  });

  it('builds the context off a row, and refuses a row missing a context column', () => {
    expect(
      contentContext(entry, { citizenid: 'C1', thread_id: 3, peer_id: null, body: 'x' })
    ).toEqual({
      table: 'test_threads',
      column: 'body',
      citizenid: 'C1',
      scope: [3, null]
    });
    expect(() => contentContext(entry, { citizenid: 'C1', thread_id: 3 })).toThrow(/peer_id/);
  });

  it('seals a row copy and opens it back, leaving the original and other columns alone', async () => {
    useKeyFile(keyFile([`k1 ${b64()}`]));
    const row = { id: 4, citizenid: 'C1', thread_id: 3, peer_id: 9, body: 'hi', other: 'o' };
    const sealed = await sealRow('test_threads', row);
    expect(row.body).toBe('hi');
    expect(isSealed(sealed.body)).toBe(true);
    expect(sealed.other).toBe('o');
    expect(openRow('test_threads', sealed)).toEqual(row);
    expect(openRows('test_threads', [sealed, row])).toEqual([row, row]);
    expect(await sealRow('test_threads', { ...row, body: null })).toEqual({ ...row, body: null });
    expect(await sealRow('elsewhere', row)).toBe(row);
  });
});

describe('boot', () => {
  it('registers the resource-start hook, and ignores other resources', () => {
    expect(startHandlers).toContain(onContentCipherResourceStart);
    onContentCipherResourceStart('some-other-resource');
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns every boot that bodies are plaintext without a key', async () => {
    await announceContentCipher();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('plaintext'));
  });

  it('says loudly that writes are refused when ciphertext exists and the key does not', async () => {
    ledger.marker = true;
    await announceContentCipher();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('refused'));
  });

  it('names the active key, and never the key itself', async () => {
    const secret = b64();
    useKeyFile(keyFile([`k7 ${secret}`]));
    await announceContentCipher();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("'k7'"));
    expect(String((console.log as any).mock.calls[0][0])).not.toContain(secret);
  });

  it('reports an unusable key file as an error', async () => {
    useKeyFile(keyFile(['k1 nope']));
    await announceContentCipher();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unusable'));
  });
});
