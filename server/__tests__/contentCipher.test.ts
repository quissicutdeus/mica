// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';

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
  __aadForTests,
  blindIndexCandidates,
  blindIndexFor,
  blindIndexKeyId,
  newSealKey,
  registerBlindIndex,
  unregisterBlindIndexForTests,
  SEALED_PREFIX,
  UNREADABLE_CONTENT,
  activeKeyId,
  announceContentCipher,
  contentContext,
  contentDigests,
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
  plaintextBytesSql,
  registerEncryptedColumn,
  resetContentCipherForTests,
  sealContent,
  sealedKeyId,
  sealedLength,
  sealedLengthForChars,
  sealRow,
  tryOpenContent,
  storablePlaintext,
  serverDataOf,
  unregisterEncryptedColumnForTests,
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
  binding: 'citizen',
  owner: 'ABC123',
  ownerKind: 'citizen',
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
    ['another citizenid', message({ owner: 'XYZ999' })],
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

describe('keyed digests (MICA-340)', () => {
  it('digests under every loaded key, active first, the same each time', () => {
    const k1 = randomBytes(32);
    useKeyFile(keyFile([`k1 ${k1.toString('base64')}`, `k0 ${b64()}`]));
    const first = contentDigests('ledger', 'CIT_A|CIT_B|You up?');
    expect(first.map((d) => d.kid)).toEqual(['k1', 'k0']);
    expect(first.map((d) => d.digest.length)).toEqual([32, 32]);
    const hex = (list: ReturnType<typeof contentDigests>): string[] =>
      list.map((d) => d.digest.toString('hex'));
    expect(hex(contentDigests('ledger', 'CIT_A|CIT_B|You up?'))).toEqual(hex(first));
    // A different key, value or purpose: a different digest.
    expect(hex(first)[0]).not.toBe(hex(first)[1]);
    expect(hex(contentDigests('ledger', 'CIT_A|CIT_B|You up!'))[0]).not.toBe(hex(first)[0]);
    expect(hex(contentDigests('other', 'CIT_A|CIT_B|You up?'))[0]).not.toBe(hex(first)[0]);
    // Never an HMAC under the content key as it is: the MAC key is derived from it.
    const direct = createHmac('sha256', k1).update('CIT_A|CIT_B|You up?').digest('hex');
    expect(hex(first)[0]).not.toBe(direct);
  });

  it('is empty with no key, and with a key file it cannot use', () => {
    expect(contentDigests('ledger', 'x')).toEqual([]);
    useKeyFile(keyFile(['k1 not-a-key']));
    resetContentCipherForTests();
    expect(contentDigests('ledger', 'x')).toEqual([]);
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

describe('where the key file lives (MICA-303)', () => {
  /**
   * A server-data on disk: micaOS at `resources/[local]/mica`, the key's own resource beside
   * it, and a directory outside server-data altogether. Real files and real symlinks, because
   * the warnings are about where the bytes are once every link is followed.
   */
  const layout = () => {
    const base = mkdtempSync(join(dir, 'layout-'));
    const serverData = join(base, 'server-data');
    const local = join(serverData, 'resources', '[local]');
    const mica = join(local, 'mica');
    const keys = join(local, 'mica-keys');
    const outside = join(base, 'outside');
    for (const path of [mica, keys, outside, join(serverData, 'secrets')]) {
      mkdirSync(path, { recursive: true });
    }
    const keyAt = (path: string): string => {
      writeFileSync(path, `k1 ${b64()}\n`);
      chmodSync(path, 0o600);
      return path;
    };
    const linkAt = (path: string, target: string): string => {
      symlinkSync(target, path);
      return path;
    };
    const where = { micaRoot: mica, serverData, mode: 0o100600 };
    return { base, serverData, mica, keys, outside, keyAt, linkAt, where };
  };

  it('says nothing for a symlink in mica-keys to a key outside server-data, the best layout', () => {
    const l = layout();
    const path = l.linkAt(join(l.keys, 'mica-content.key'), l.keyAt(join(l.outside, 'k')));
    expect(keyFileWarnings(path, l.where)).toEqual([]);
  });

  it('warns that a key really inside server-data travels with its backups', () => {
    const l = layout();
    const plain = l.keyAt(join(l.keys, 'mica-content.key'));
    expect(keyFileWarnings(plain, l.where)).toEqual([
      expect.stringMatching(/is inside server-data, so every backup of server-data carries it/)
    ]);
    // A symlink that only leads back into server-data is no better, and the warning says where.
    const secret = l.keyAt(join(l.serverData, 'secrets', 'k'));
    const linked = l.linkAt(join(l.keys, 'linked.key'), secret);
    const [warning, ...rest] = keyFileWarnings(linked, l.where);
    expect(rest).toEqual([]);
    expect(warning).toContain(`leads to ${secret}, which is inside server-data`);
  });

  it("warns that a key in micaOS's own folder goes with the next update, and only that", () => {
    const l = layout();
    const inMica = l.keyAt(join(l.mica, 'mica-content.key'));
    expect(keyFileWarnings(inMica, l.where)).toEqual([
      expect.stringContaining("inside micaOS's own resource folder, which an update replaces")
    ]);
    // A link there to a key kept outside: the update deletes the link, so it warns too.
    const link = l.linkAt(join(l.mica, 'linked.key'), l.keyAt(join(l.outside, 'k')));
    expect(keyFileWarnings(link, l.where)).toEqual([
      expect.stringContaining("micaOS's own resource folder")
    ]);
    // And a link in mica-keys to a key that really sits in micaOS's folder: the update
    // deletes the key itself.
    const intoMica = l.linkAt(join(l.keys, 'into-mica.key'), inMica);
    expect(keyFileWarnings(intoMica, l.where)).toEqual([
      expect.stringContaining("micaOS's own resource folder")
    ]);
  });

  it("knows micaOS's folder when FXServer reaches it through a symlink", () => {
    const l = layout();
    const real = join(l.base, 'checkout', 'mica');
    mkdirSync(real, { recursive: true });
    const viaLink = l.linkAt(join(l.serverData, 'resources', 'mica-linked'), real);
    const key = l.keyAt(join(viaLink, 'mica-content.key'));
    expect(keyFileWarnings(key, { ...l.where, micaRoot: viaLink })).toEqual([
      expect.stringContaining("micaOS's own resource folder")
    ]);
  });

  it('says nothing about a key outside server-data, or in a sibling sharing its prefix', () => {
    const l = layout();
    expect(keyFileWarnings(l.keyAt(join(l.outside, 'k')), l.where)).toEqual([]);
    expect(
      keyFileWarnings('/srv/fx/server-data-keys/mica.key', {
        micaRoot: '/srv/fx/server-data/resources/mica',
        serverData: '/srv/fx/server-data',
        mode: 0o100600
      })
    ).toEqual([]);
  });

  it('warns when group or world can read it, and says nothing about a 0600 file', () => {
    expect(
      keyFileWarnings('/etc/mica/key', { micaRoot: null, serverData: null, mode: 0o100640 })
    ).toEqual([expect.stringContaining('chmod 600')]);
    expect(
      keyFileWarnings('/etc/mica/key', { micaRoot: null, serverData: null, mode: 0o100600 })
    ).toEqual([]);
  });

  it('says so at load when the real file is group-readable, and still loads it', async () => {
    useKeyFile(keyFile([`k1 ${b64()}`], 0o644));
    expect(activeKeyId()).toBe('k1');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
  });

  it("warns at load, from FXServer's own paths, for a key in micaOS's folder and not in mica-keys", () => {
    const l = layout();
    (globalThis as any).GetResourcePath = (name: string) => (name === 'mica' ? l.mica : '');
    try {
      useKeyFile(l.keyAt(join(l.mica, 'mica-content.key')));
      expect(activeKeyId()).toBe('k1');
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("micaOS's own resource folder")
      );

      vi.mocked(console.warn).mockClear();
      resetContentCipherForTests();
      useKeyFile(l.linkAt(join(l.keys, 'mica-content.key'), l.keyAt(join(l.outside, 'k'))));
      expect(activeKeyId()).toBe('k1');
      expect(console.warn).not.toHaveBeenCalled();

      // server-data comes from micaOS's resource path, not from where the suite started.
      resetContentCipherForTests();
      useKeyFile(l.keyAt(join(l.keys, 'plain.key')));
      expect(activeKeyId()).toBe('k1');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('inside server-data'));
    } finally {
      delete (globalThis as any).GetResourcePath;
    }
  });

  it("a key file that is not there or will not read names FXServer's rule and keygen", async () => {
    for (const path of [join(dir, 'nowhere.key'), mkdtempSync(join(dir, 'a-directory-'))]) {
      resetContentCipherForTests();
      vi.mocked(console.error).mockClear();
      useKeyFile(path);
      await announceContentCipher();
      const said = String(vi.mocked(console.error).mock.calls[0]?.[0]);
      expect(said).toContain('unusable');
      expect(said).toContain('FXServer will not let micaOS read it');
      expect(said).toContain('a resource may read only files inside a resource folder');
      expect(said).toContain('mica-keys; micacrypt keygen prints the layout');
    }
  });
});

describe('serverDataOf: server-data from where FXServer says micaOS is', () => {
  it.each([
    ['/srv/fx/server-data/resources/[local]/mica', '/srv/fx/server-data'],
    ['/srv/fx/server-data/resources/mica/', '/srv/fx/server-data'],
    ['/srv/fx/server-data/resources//[local]/mica', '/srv/fx/server-data'],
    ['/home/resources/fx/server-data/resources/mica', '/home/resources/fx/server-data'],
    ['C:\\FXServer\\server-data\\resources\\[local]\\mica', 'C:/FXServer/server-data'],
    ['/opt/mica', null],
    ['', null],
    [null, null]
  ])('%j → %j', (micaRoot, expected) => {
    expect(serverDataOf(micaRoot)).toBe(expected);
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
    // Registered with its binding stated (MICA-431): absent reads as the character.
    expect(encryptedColumns()).toContainEqual({ ...entry, binding: 'citizen' });
    expect(encryptedColumnsOf('test_threads')).toEqual([{ ...entry, binding: 'citizen' }]);
    expect(encryptedColumnsOf('elsewhere')).toEqual([]);
    expect(encryptedColumn('test_threads', 'body')).toEqual({ ...entry, binding: 'citizen' });
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
      binding: 'citizen',
      owner: 'C1',
      ownerKind: 'citizen',
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

/**
 * MICA-431: a value on a phone's own table is bound to the phone, not the character, so it
 * survives the handover that rewrites the row's `citizenid` — and every value sealed before
 * still opens, because a character-bound value's authenticated data is byte for byte what it
 * was.
 */
describe('the binding (MICA-431)', () => {
  const notes = {
    table: 'test_notes',
    column: 'content',
    scope: [] as string[],
    hasUpdatedAt: true,
    binding: 'device' as const
  };
  beforeEach(() => registerEncryptedColumn(notes));
  afterEach(() => unregisterEncryptedColumnForTests('test_notes', 'content'));

  it("keeps a character-bound value's authenticated data byte for byte", () => {
    expect(__aadForTests(message())).toBe('micaOS content v1\0mica_messages\0message\0ABC123\x007');
  });

  it('opens a value sealed the way MICA-165 sealed it, built here by hand', () => {
    // The ciphertext is made with node:crypto against the literal pre-MICA-431 AAD, not through
    // the code under test, so a change to that AAD's bytes cannot pass by changing both sides.
    const key = randomBytes(32);
    useKeyFile(keyFile([`k1 ${key.toString('base64')}`]));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('micaOS content v1\0mica_messages\0message\0ABC123\x007', 'utf8'));
    const body = Buffer.concat([cipher.update('from before', 'utf8'), cipher.final()]);
    const stored =
      `${SEALED_PREFIX}k1$` + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
    expect(openContent(message(), stored, 1)).toBe('from before');
  });

  it('binds a phone-bound value to device_id under its own domain', () => {
    const context = contentContext(encryptedColumn('test_notes', 'content')!, {
      citizenid: 'C1',
      device_id: 'abc'
    });
    expect(context).toMatchObject({ binding: 'device', owner: 'abc', ownerKind: 'device' });
    expect(__aadForTests(context)).toBe(
      'micaOS device content v1\0test_notes\0content\0device\0abc'
    );
    expect(contextColumns(encryptedColumn('test_notes', 'content')!)).toEqual([
      'device_id',
      'citizenid'
    ]);
  });

  it('opens a phone-bound value after a handover rewrites the citizenid', async () => {
    useKeyFile(keyFile([`k1 ${b64()}`]));
    const row = { id: 1, citizenid: 'C1', device_id: 'abc', content: 'shopping list' };
    const sealed = await sealRow('test_notes', row);
    expect(isSealed(sealed.content)).toBe(true);
    // The handover: same phone, a new holder.
    expect(openRow('test_notes', { ...sealed, citizenid: 'C2' }).content).toBe('shopping list');
    // The positive twin: another phone's row will not open it.
    expect(openRow('test_notes', { ...sealed, device_id: 'xyz' }).content).toBe(UNREADABLE_CONTENT);
  });

  it('binds a row with no device_id to its citizenid, which nothing then moves', async () => {
    useKeyFile(keyFile([`k1 ${b64()}`]));
    const legacy = { id: 2, citizenid: 'C1', device_id: null, content: 'old note' };
    const context = contentContext(encryptedColumn('test_notes', 'content')!, legacy);
    expect(context).toMatchObject({ owner: 'C1', ownerKind: 'citizen' });
    expect(__aadForTests(context)).toBe(
      'micaOS device content v1\0test_notes\0content\0citizen\0C1'
    );
    const sealed = await sealRow('test_notes', legacy);
    expect(openRow('test_notes', sealed).content).toBe('old note');
    // Not one shared owner: another player's legacy row will not open it.
    expect(openRow('test_notes', { ...sealed, citizenid: 'C2' }).content).toBe(UNREADABLE_CONTENT);
    // And a device id that happens to spell a citizenid is still another owner.
    expect(openRow('test_notes', { ...sealed, device_id: 'C1' }).content).toBe(UNREADABLE_CONTENT);
  });

  it('refuses device_id in a scope, and an unknown binding', () => {
    expect(() =>
      registerEncryptedColumn({ ...notes, column: 'title', scope: ['device_id'] })
    ).toThrow(/device_id/);
    expect(() =>
      registerEncryptedColumn({ ...notes, column: 'title', binding: 'phone' as never })
    ).toThrow(/no binding/);
  });

  it('never measures a truncated sealed value below zero', () => {
    // The arithmetic subtracts the IV and the tag, so `$mc1$k1$` with nothing after it would
    // read as -30 and lower a quota sum. No suite here runs SQL; test:schema proves the value.
    const sql = plaintextBytesSql('`data`');
    expect(sql.startsWith('GREATEST((CASE WHEN `data` LIKE')).toBe(true);
    expect(sql.endsWith('END), 0)')).toBe(true);
  });

  it('bounds an ASCII column at one byte a character, so a 4 MiB photo fits a mediumtext', () => {
    expect(maxPlaintextChars(16777215, 1)).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    // The four-byte bound is the one that refused it.
    expect(maxPlaintextChars(16777215)).toBeLessThan(4 * 1024 * 1024);
    expect(sealedLength(maxPlaintextChars(16777215, 1))).toBeLessThanOrEqual(16777215);
  });
});

/**
 * MICA-432: the blind index beside a sealed value something looks up or keeps unique, and the
 * binding to a row for a table whose owner passes on.
 */
describe('blind indexes (MICA-432)', () => {
  const numbers = {
    table: 'test_book',
    column: 'phone',
    scope: [] as string[],
    hasUpdatedAt: true,
    binding: 'device' as const
  };
  const index = {
    table: 'test_book',
    column: 'phone',
    index: 'phone_index',
    scope: ['device_id'],
    normalize: (value: string) => value.toLowerCase().trimEnd()
  };
  beforeEach(() => {
    registerEncryptedColumn(numbers);
    registerBlindIndex(index);
  });
  afterEach(() => {
    unregisterBlindIndexForTests('test_book', 'phone');
    unregisterEncryptedColumnForTests('test_book', 'phone');
  });
  const onPhone = { device_id: 'a'.repeat(32) };

  it('is the normalized value, marked plain, on a server that never had a key', async () => {
    expect(await blindIndexFor(index, onPhone, '555-TAXI ')).toBe('plain:555-taxi');
    expect(await blindIndexCandidates(index, onPhone, '555-taxi')).toEqual(['plain:555-taxi']);
    expect(blindIndexKeyId('plain:555-taxi')).toBe('plain');
    expect(ledger.marker).toBe(false);
  });

  it('is a keyed digest under the active key, the same for the same value in the same scope', async () => {
    const key = randomBytes(32);
    useKeyFile(keyFile([`k1 ${key.toString('base64')}`]));
    const first = await blindIndexFor(index, onPhone, '555-TAXI');
    expect(first).toMatch(/^k1\$[0-9a-f]{64}$/);
    expect(await blindIndexFor(index, onPhone, '555-taxi ')).toBe(first);
    // Equal only for equal values in one scope: another phone gives an unrelated digest.
    expect(await blindIndexFor(index, { device_id: 'b'.repeat(32) }, '555-taxi')).not.toBe(first);
    expect(await blindIndexFor(index, onPhone, '555-0100')).not.toBe(first);
    // Its own derivation: not an HMAC under the content key as it is.
    const raw = createHmac('sha256', key)
      .update(['test_book', 'phone', onPhone.device_id, '555-taxi'].join('\0'))
      .digest('hex');
    expect(first).not.toBe(`k1$${raw}`);
    // And a keyed index is recorded as keyed data, as a sealed value is.
    expect(ledger.marker).toBe(true);
    expect(blindIndexKeyId(first)).toBe('k1');
  });

  it('is looked up by every form a stored one can take: each loaded key, then plain', async () => {
    useKeyFile(keyFile([`k2 ${b64()}`, `k1 ${b64()}`]));
    const candidates = await blindIndexCandidates(index, onPhone, '555-taxi');
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toBe(await blindIndexFor(index, onPhone, '555-taxi'));
    expect(candidates[0]).toMatch(/^k2\$/);
    expect(candidates[1]).toMatch(/^k1\$/);
    expect(candidates[2]).toBe('plain:555-taxi');
  });

  it('fails closed: refused key file, or no key over a database that holds keyed data', async () => {
    useKeyFile(keyFile([`not a key`]));
    await expect(blindIndexFor(index, onPhone, '1')).rejects.toThrow(/unusable/);
    await expect(blindIndexCandidates(index, onPhone, '1')).rejects.toThrow(/unusable/);
    useKeyFile('');
    resetContentCipherForTests();
    ledger.marker = true;
    await expect(blindIndexFor(index, onPhone, '1')).rejects.toThrow(/missing/);
    await expect(blindIndexCandidates(index, onPhone, '1')).rejects.toThrow(/missing/);
  });

  it('refuses a row without its scope, an index over a plaintext column, and a second one', async () => {
    await expect(blindIndexCandidates(index, {}, '1')).rejects.toThrow(/device_id/);
    expect(() => registerBlindIndex({ ...index, table: 'test_plain' })).toThrow(/not sealed/);
    expect(() => registerBlindIndex(index)).toThrow(/already has/);
    expect(() => registerBlindIndex({ ...index, column: 'phone', scope: ['phone'] })).toThrow();
  });
});

describe('the row binding (MICA-432)', () => {
  const names = {
    table: 'test_rooms',
    column: 'name',
    scope: [] as string[],
    hasUpdatedAt: true,
    binding: 'row' as const
  };
  beforeEach(() => registerEncryptedColumn(names));
  afterEach(() => unregisterEncryptedColumnForTests('test_rooms', 'name'));

  it("binds to the row's seal key, under its own domain, and not to its owner", async () => {
    useKeyFile(keyFile([`k1 ${b64()}`]));
    expect(contextColumns(encryptedColumn('test_rooms', 'name')!)).toEqual(['seal_key']);
    const row = { citizenid: 'FIRST_OWNER', seal_key: 'k'.repeat(32), name: 'Docks' };
    const context = contentContext(encryptedColumn('test_rooms', 'name')!, row);
    expect(__aadForTests(context)).toBe(
      `micaOS row content v1\0test_rooms\0name\0row\0${'k'.repeat(32)}`
    );
    const sealed = await sealRow('test_rooms', row);
    // The owner passes on: still opens.
    expect(openRow('test_rooms', { ...sealed, citizenid: 'HEIR' }).name).toBe('Docks');
    // Another row's key: does not.
    expect(openRow('test_rooms', { ...sealed, seal_key: 'j'.repeat(32) }).name).toBe(
      UNREADABLE_CONTENT
    );
  });

  it('refuses to seal or open a row with no seal key', () => {
    expect(() =>
      contentContext(encryptedColumn('test_rooms', 'name')!, { seal_key: null })
    ).toThrow(/no seal_key/);
    expect(() =>
      registerEncryptedColumn({ ...names, column: 'topic', scope: ['seal_key'] })
    ).toThrow(/seal_key/);
    expect(newSealKey()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSealKey()).not.toBe(newSealKey());
  });
});
