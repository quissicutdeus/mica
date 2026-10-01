// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer, type Bytes } from 'node:buffer';
import { createDecipheriv } from 'node:crypto';

/**
 * A second reader of the sealed form (MICA-165), written from its documented shape rather than
 * imported from `server/lib/contentCipher.ts`.
 *
 * That is the point of it. A body the suite reads back through micaOS's own opener proves only
 * that micaOS agrees with itself; one this file opens, with the key the harness wrote and the
 * authenticated data the format names, proves the stored value is real AES-256-GCM under that
 * key and bound to the row it sits in. `integrationSealed.test.ts` holds this reader to the
 * real sealer, so the two cannot drift apart unnoticed.
 *
 * `$mc1$<kid>$<base64(iv[12] || ciphertext || tag[16])>`, AAD the NUL-joined
 * `micaOS content v1`, table, column, the row's citizenid, then the service's scope columns.
 */
export const SEALED_PREFIX = '$mc1$';

const KID = /^[a-z0-9-]{1,16}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AAD_DOMAIN = 'micaOS content v1';

export interface SealedContext {
  table: string;
  column: string;
  citizenid: string;
  scope: readonly (string | number | null)[];
}

/** A keyring file's keys by id: `<kid> <base64 of 32 bytes>` a line, `#` and blanks ignored. */
export const parseKeyFile = (text: string): Map<string, Bytes> => {
  const keys = new Map<string, Bytes>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [kid, encoded, extra] = line.split(/\s+/);
    if (extra !== undefined || !KID.test(kid ?? '') || !encoded) {
      throw new Error(`the key file has a line that is not '<kid> <base64 key>'`);
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) throw new Error(`the key '${kid}' is not ${KEY_BYTES} bytes`);
    keys.set(kid, key);
  }
  if (keys.size === 0) throw new Error('the key file holds no key');
  return keys;
};

/** The key id a stored value names, or null when it is not in the sealed form. */
export const sealedKid = (stored: unknown): string | null => {
  if (typeof stored !== 'string' || !stored.startsWith(SEALED_PREFIX)) return null;
  const end = stored.indexOf('$', SEALED_PREFIX.length);
  if (end < 0) return null;
  const kid = stored.slice(SEALED_PREFIX.length, end);
  return KID.test(kid) ? kid : null;
};

/** Open a sealed value, or throw saying why it would not open. Plaintext is refused too. */
export const openSealed = (
  stored: unknown,
  keys: ReadonlyMap<string, Uint8Array>,
  context: SealedContext
): string => {
  const kid = sealedKid(stored);
  if (kid === null) throw new Error('the stored value is not in the sealed form');
  const key = keys.get(kid);
  if (!key) throw new Error(`the stored value names key '${kid}', which the key file lacks`);
  const payload = Buffer.from(
    (stored as string).slice(SEALED_PREFIX.length + kid.length + 1),
    'base64'
  );
  if (payload.length < IV_BYTES + TAG_BYTES) throw new Error('the sealed payload is too short');

  const aad = Buffer.from(
    [
      AAD_DOMAIN,
      context.table,
      context.column,
      context.citizenid,
      ...context.scope.map((value) => (value === null ? '' : String(value)))
    ].join('\0'),
    'utf8'
  );
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new Error(`the sealed value in ${context.table}.${context.column} does not authenticate`);
  }
};
