// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * MICA-302: the integration suite opens sealed bodies with a reader of its own
 * (`integration/lib/sealed.ts`), written from the documented format rather than imported, so a
 * pass in the game proves the stored value — not just that micaOS agrees with itself. This holds
 * that reader to the real sealer (`server/lib/contentCipher.ts`, MICA-165): if either drifts, the
 * in-server scenarios would fail for the wrong reason, and this says which side moved.
 */
const { dbMock } = vi.hoisted(() => ({ dbMock: { query: vi.fn() } }));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { contentContext, resetContentCipherForTests, sealContent } from '../lib/contentCipher';
import { openSealed, parseKeyFile, sealedKid } from '../../integration/lib/sealed';

const dir = mkdtempSync(join(tmpdir(), 'mica-integration-key-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keyText = `# harness key\nit1 ${randomBytes(32).toString('base64')}\nold ${randomBytes(32).toString('base64')}\n`;
const keyPath = join(dir, 'mica-content.key');
writeFileSync(keyPath, keyText, { mode: 0o600 });

beforeEach(() => {
  resetContentCipherForTests();
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_content_key_file' ? keyPath : fallback;
  dbMock.query.mockReset();
  dbMock.query.mockImplementation(async (sql: string) => {
    if (sql.includes('information_schema.COLUMNS')) return [{ chars: 65535, bytes: 65535 }];
    if (sql.startsWith('INSERT IGNORE')) return { affectedRows: 1 };
    return [{ n: 0 }];
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The integration reader's own context shape, citizen-bound as every value it reads is. */
type Legacy = { table: string; column: string; citizenid: string; scope: number[] };
const message: Legacy = {
  table: 'mica_messages',
  column: 'message',
  citizenid: 'ABC123',
  scope: [7]
};
const mail: Legacy = { table: 'mica_mail', column: 'content', citizenid: 'XYZ', scope: [] };
/** The same place as the real sealer names it (MICA-431): bound to the character. */
const sealer = (c: Legacy) => ({
  table: c.table,
  column: c.column,
  binding: 'citizen' as const,
  owner: c.citizenid,
  ownerKind: 'citizen' as const,
  scope: c.scope
});

describe('the integration reader of sealed bodies', () => {
  it('opens what the real sealer sealed, with the scope and without one', async () => {
    const keys = parseKeyFile(keyText);
    const body = 'héllo — ✓ 🔒 multi\nline';
    const sealedMessage = await sealContent(sealer(message), body);
    expect(sealedKid(sealedMessage)).toBe('it1');
    expect(openSealed(sealedMessage, keys, message)).toBe(body);

    const sealedMail = await sealContent(sealer(mail), body);
    expect(openSealed(sealedMail, keys, mail)).toBe(body);
  });

  it('refuses a value moved to another row, thread, column or table', async () => {
    const keys = parseKeyFile(keyText);
    const sealed = await sealContent(sealer(message), 'bound');
    for (const moved of [
      { ...message, citizenid: 'OTHER' },
      { ...message, scope: [8] },
      { ...message, column: 'body' },
      { ...message, table: 'mica_blabber_dms' }
    ]) {
      expect(() => openSealed(sealed, keys, moved)).toThrow(/does not authenticate/);
    }
  });

  /**
   * MICA-431: a phone's own table is sealed to the phone, so the reader opens it by the row's
   * `device_id`, after a handover changed its citizenid, and by the citizenid on a row with no
   * phone. Sealed here by the real sealer, from the real context of a phone-bound entry.
   */
  it('opens a value sealed to the phone, and to the citizen on a row with no phone', async () => {
    const keys = parseKeyFile(keyText);
    const phoneBound = {
      table: 'mica_notes',
      column: 'content',
      scope: [] as string[],
      hasUpdatedAt: true,
      binding: 'device' as const
    };
    const onPhone = { citizenid: 'ABC123', device_id: 'a'.repeat(32) };
    const sealed = await sealContent(contentContext(phoneBound, onPhone), 'milk');
    const context = {
      table: 'mica_notes',
      column: 'content',
      citizenid: 'NEW_HOLDER',
      deviceId: onPhone.device_id,
      scope: []
    };
    expect(openSealed(sealed, keys, context)).toBe('milk');
    for (const moved of [
      { ...context, deviceId: 'b'.repeat(32) },
      // Read as if sealed to the character, it does not open: the two domains differ.
      { table: 'mica_notes', column: 'content', citizenid: 'ABC123', scope: [] }
    ]) {
      expect(() => openSealed(sealed, keys, moved)).toThrow(/does not authenticate/);
    }

    const noPhone = { citizenid: 'ABC123', device_id: null };
    const legacy = await sealContent(contentContext(phoneBound, noPhone), 'old');
    expect(openSealed(legacy, keys, { ...context, citizenid: 'ABC123', deviceId: null })).toBe(
      'old'
    );
    expect(() =>
      openSealed(legacy, keys, { ...context, citizenid: 'OTHER', deviceId: null })
    ).toThrow(/does not authenticate/);
  });

  it('refuses plaintext, a key it lacks, and a malformed value', async () => {
    const keys = parseKeyFile(keyText);
    expect(() => openSealed('plain text', keys, message)).toThrow(/not in the sealed form/);
    const sealed = await sealContent(sealer(message), 'x');
    expect(() => openSealed(sealed, new Map(), message)).toThrow(/lacks/);
    expect(() => openSealed('$mc1$it1$AAAA', keys, message)).toThrow(/too short/);
    expect(sealedKid('$mc1$Bad Kid$xx')).toBeNull();
  });

  it('reads the keyring format micaOS reads, and refuses what micaOS refuses', () => {
    expect([...parseKeyFile(keyText).keys()]).toEqual(['it1', 'old']);
    expect(() => parseKeyFile('# nothing\n')).toThrow(/no key/);
    expect(() => parseKeyFile(`it1 ${randomBytes(16).toString('base64')}`)).toThrow(/32 bytes/);
    expect(() => parseKeyFile('it1 a b')).toThrow(/not '<kid> <base64 key>'/);
  });
});
