// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer, type Bytes } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { NO_REASON, reasonOf } from './sqlErrors';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { cwd, platform } from 'node:process';
import { Database } from './Database';
import { PlayerFacingError } from './errors';
import { whenSchemaReady } from './schemaReady';

/**
 * Message, DM and mail bodies encrypted at rest (MICA-165).
 *
 * **What this defends: a leaked database dump.** A backup left on a share, a dump pasted into a
 * support thread, a hosting panel's export. It does not defend against the operator, who holds
 * the key and runs the code that uses it, and it does not pretend to.
 *
 * AES-256-GCM in the application, through Node's `crypto` — never MySQL's `AES_ENCRYPT`, which
 * would put the key in every statement and so in the query log and the process list, next to
 * the data it protects.
 *
 * - **The key** is a keyring file whose absolute path is the convar `mica_content_key_file`.
 *   Never the key itself in a convar: `server.cfg` is the file most often pasted, shared and
 *   committed. One key per line, `<kid> <base64 of 32 bytes>`; `#` comments and blank lines are
 *   ignored; the **first** key seals, every key opens. Read once, at first use or resource
 *   start, whichever comes first.
 * - **Where it lives** is decided by FXServer, not by micaOS (MICA-303): a resource's Node code
 *   may read files only inside a resource folder, its own or another's. So the key goes in a
 *   resource of its own, `mica-keys`, never in micaOS's folder, which an update replaces — best
 *   as a symlink there to a key kept outside server-data. `micacrypt keygen` prints the steps;
 *   it cannot do them, because a resource may write into no folder but its own.
 * - **No key configured** is legal and stores plaintext, as micaOS always has, with a warning
 *   every boot. But once anything has been sealed — an "enabled" marker in the migrations
 *   ledger records the first successful seal — a missing key refuses every write rather than
 *   quietly going back to plaintext beside ciphertext.
 * - **A key file configured but unusable** (missing, unreadable, malformed, relative) is never
 *   read as "no key": every seal throws until it is fixed. Silence there would be plaintext
 *   written under an owner who believes it is encrypted.
 * - **The stored form** is `$mc1$<kid>$<base64(iv || ciphertext || tag)>`, a fresh 12-byte IV
 *   per seal. Dollar-delimited, and never `mica:`-prefixed, which `eventNames.test.ts` would
 *   read as a net event name.
 * - **The authenticated data** binds a value to where it lives: the table, the column, the
 *   row's `citizenid` and the service's declared scope columns (a message's conversation, a
 *   DM's two accounts). A ciphertext copied into another row, thread or column fails to open.
 *   Not the row id, which does not exist until the insert that stores the ciphertext.
 * - **Opening** passes an unprefixed value through untouched — legacy plaintext, readable as it
 *   always was — and turns a prefixed value that will not open into `UNREADABLE_CONTENT`,
 *   logged once per row. One bad row never breaks a thread or a list.
 *
 * The encrypted columns are declared on their services (`encrypted: true` on the column, the
 * scope on the service) and registered here by `defineService`, so every consumer — the
 * generic repository path, the hand-written readers, the backfill — walks one list.
 */

// ─── format ──────────────────────────────────────────────────────────────────────────────────

/** The version tag every sealed value starts with. A new format is a new tag, never a reuse. */
export const SEALED_PREFIX = '$mc1$';

/** A key id: short, lower-case, and safe inside the dollar-delimited form. */
const KID_PATTERN = /^[a-z0-9-]{1,16}$/;
const MAX_KID_LENGTH = 16;

/** Whether `kid` may name a key: what `micacrypt keygen` checks before printing it. */
export const isKeyId = (kid: string): boolean => KID_PATTERN.test(kid);

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * What a reader is shown for a value that is sealed but will not open: a padlock.
 *
 * Language-neutral on purpose — it lands in a message bubble, an inbox preview and an export,
 * none of which can be sure which catalog the reader has — and never an error, because one row
 * with a lost key must not take the rest of its thread down with it.
 */
export const UNREADABLE_CONTENT = '\u{1F512}';

/**
 * Bound into every value's authenticated data. A new meaning for any part of the AAD is a new
 * domain string, so a value sealed under the old meaning cannot be read under the new one.
 */
const AAD_DOMAIN = 'micaOS content v1';

/**
 * The domain of a value bound to a **phone** rather than a character (MICA-431): a column of a
 * `deviceOwned` table, whose rows belong to the device. Bound to `device_id`, which nothing
 * rewrites, a value opens only on its own phone. When MICA-431 chose this, a handover moved a
 * phone's rows to a new holder by rewriting `citizenid`; MICA-436 removed the handover and
 * MICA-438 gave each character one phone, so the binding no longer has a move to survive, but
 * it still keeps a value off every other phone, the same character's tablet included.
 *
 * A separate domain rather than the device id in the citizen slot, so no value sealed under one
 * meaning can ever be read under the other.
 */
const AAD_DEVICE_DOMAIN = 'micaOS device content v1';

/**
 * The domain of a value bound to its **row** (MICA-432): a table whose `citizenid` is not the
 * value's owner and can change hands — a Dark Chat channel's owner passes to its next member, a
 * group thread's creator can leave. Bound to `citizenid` such a value would stop opening at the
 * first move. Bound instead to `seal_key`, a random key drawn for the row when it is written and
 * never rewritten (`newSealKey`): the row id would do, but it is not known until after the
 * insert the value has to be sealed for.
 */
const AAD_ROW_DOMAIN = 'micaOS row content v1';

/** The column a row-bound value's owner is read from. */
export const SEAL_KEY_COLUMN = 'seal_key';
/** A row's seal key: sixteen random bytes, as 32 hex characters. */
export const SEAL_KEY_LENGTH = 32;
export const newSealKey = (): string => randomBytes(SEAL_KEY_LENGTH / 2).toString('hex');

/** Worst case for utf8mb4: every character four bytes. */
const MAX_BYTES_PER_CHAR = 4;

const BASE64_CHAR_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The longest sealed form of a plaintext of at most `maxPlaintextBytes` UTF-8 bytes, with the
 * longest possible key id. Every character of it is ASCII, so this is its length in bytes and
 * in characters alike — which is what makes it the width a column needs.
 */
export const sealedLength = (maxPlaintextBytes: number): number =>
  SEALED_PREFIX.length +
  MAX_KID_LENGTH +
  1 +
  4 * Math.ceil((IV_BYTES + maxPlaintextBytes + TAG_BYTES) / 3);

/**
 * SQL for the plaintext's size in bytes, as `LENGTH` measured it before the value was sealed,
 * read off the sealed value's own length without opening it (MICA-431). GCM's ciphertext is as
 * long as its plaintext, so the base64 after `$mc1$<kid>$` decodes to the IV, the plaintext and
 * the tag, and padding says how many of its last bytes are not there. A value not in the sealed
 * form is measured as it is; NULL stays NULL.
 *
 * For a size a reader is told — a privacy export's `<column>_bytes`, a quota measuring a row with
 * no size recorded — where `LENGTH` of the stored form would read a third high. `expression` is
 * a column reference built from declared identifiers, never from a payload.
 */
export const plaintextBytesSql = (expression: string): string =>
  // Never below zero: a truncated or malformed sealed value is shorter than an IV and a tag, and
  // read as a negative size it would lower whatever sum it is part of — a quota, above all.
  // NULL stays NULL: `GREATEST` of a NULL is NULL.
  `GREATEST((CASE WHEN ${expression} LIKE '${SEALED_PREFIX}%' ` +
  `THEN ((LENGTH(${expression}) - LENGTH(SUBSTRING_INDEX(${expression}, '$', 3)) - 1) DIV 4) * 3 ` +
  `- (RIGHT(${expression}, 1) = '=') - (RIGHT(${expression}, 2) = '==') - ${IV_BYTES + TAG_BYTES} ` +
  `ELSE LENGTH(${expression}) END), 0)`;

/** `sealedLength` for a bound in characters, at utf8mb4's worst case of four bytes each. */
export const sealedLengthForChars = (maxChars: number): number =>
  sealedLength(maxChars * MAX_BYTES_PER_CHAR);

/**
 * The most characters whose worst-case sealed form fits in `capacity` bytes — how long a
 * message may be when its column is a `text` (65,535 bytes) that now holds ciphertext.
 *
 * `bytesPerChar` is utf8mb4's worst case of four unless the column only ever holds ASCII
 * (`ColumnDef.ascii`, MICA-431): a base64 photo is one byte a character, and bounding it at
 * four would refuse a photo `mediumtext` holds sealed with room to spare.
 */
export const maxPlaintextChars = (capacity: number, bytesPerChar = MAX_BYTES_PER_CHAR): number => {
  const fits = (chars: number) => sealedLength(chars * bytesPerChar) <= capacity;
  let chars = Math.max(
    0,
    Math.floor(
      (Math.floor((capacity - (SEALED_PREFIX.length + MAX_KID_LENGTH + 1)) / 4) * 3 -
        IV_BYTES -
        TAG_BYTES) /
        bytesPerChar
    )
  );
  // The closed form rounds; the definition is the check.
  while (chars > 0 && !fits(chars)) chars -= 1;
  while (fits(chars + 1)) chars += 1;
  return chars;
};

/** Whether a stored value is in the sealed form. Anything else is legacy plaintext. */
export const isSealed = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(SEALED_PREFIX);

/** The key id a sealed value names, or null for plaintext and a malformed prefix. */
export const sealedKeyId = (value: unknown): string | null => {
  if (!isSealed(value)) return null;
  const end = value.indexOf('$', SEALED_PREFIX.length);
  if (end < 0) return null;
  const kid = value.slice(SEALED_PREFIX.length, end);
  return KID_PATTERN.test(kid) ? kid : null;
};

// ─── the registry ────────────────────────────────────────────────────────────────────────────

/**
 * Who a value belongs to (MICA-431): the character (`citizenid`), or the phone (`device_id`) for
 * a `deviceOwned` table, whose rows belong to the device, or the row itself (`seal_key`,
 * MICA-432) for a table whose `citizenid` passes from one owner to the next.
 */
export type ContentBinding = 'citizen' | 'device' | 'row';

/** One encrypted column, as its service declared it. */
export interface EncryptedColumn {
  readonly table: string;
  readonly column: string;
  /**
   * The row's own columns bound into the AAD after the owner, in this order — the thread a
   * value belongs to. A value that moved to another thread would stop opening, so nothing may
   * ever rewrite one of these, or the owner, on a row that holds ciphertext.
   */
  readonly scope: readonly string[];
  /** Who the value belongs to. Absent means `citizen`, as every column before MICA-431 was. */
  readonly binding?: ContentBinding;
  /** Whether the table has `updated_at`, which a rewrite of the column must pin, not move. */
  readonly hasUpdatedAt: boolean;
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const registry: EncryptedColumn[] = [];

/**
 * The registry by table, rebuilt for a table whenever one of its columns is registered or taken
 * out (MICA-378). Every read and write of every repository asks for its table's columns, most of
 * them for a table with none, and `openRows` asked once per row; filtering the whole registry
 * each time was a scan per row for an answer fixed at resource start.
 */
const byTable = new Map<string, readonly EncryptedColumn[]>();
const NONE: readonly EncryptedColumn[] = Object.freeze([]);

const reindex = (table: string): void => {
  const entries = registry.filter((entry) => entry.table === table);
  if (entries.length === 0) byTable.delete(table);
  else byTable.set(table, Object.freeze(entries));
};

/**
 * Add a column to the registry. `defineService` calls this for every `encrypted: true` column;
 * a test may call it for a table of its own.
 *
 * Identifiers are checked here, not trusted, because every consumer interpolates them into SQL.
 */
export const registerEncryptedColumn = (entry: EncryptedColumn): void => {
  const names = [entry.table, entry.column, ...entry.scope];
  const bad = names.find((name) => !IDENTIFIER.test(name));
  if (bad !== undefined) {
    throw new Error(`[contentCipher] '${bad}' is not a lower_snake_case identifier.`);
  }
  const binding = entry.binding ?? 'citizen';
  if (binding !== 'citizen' && binding !== 'device' && binding !== 'row') {
    throw new Error(`[contentCipher] ${entry.table}.${entry.column}: no binding '${binding}'.`);
  }
  if (
    entry.scope.includes(entry.column) ||
    entry.scope.includes('citizenid') ||
    entry.scope.includes('device_id') ||
    entry.scope.includes(SEAL_KEY_COLUMN)
  ) {
    throw new Error(
      `[contentCipher] ${entry.table}.${entry.column}: the scope names the column itself, ` +
        `'citizenid', 'device_id' or '${SEAL_KEY_COLUMN}', which the binding already binds.`
    );
  }
  if (new Set(entry.scope).size !== entry.scope.length) {
    throw new Error(`[contentCipher] ${entry.table}.${entry.column}: the scope repeats a column.`);
  }
  if (encryptedColumn(entry.table, entry.column)) {
    throw new Error(`[contentCipher] ${entry.table}.${entry.column} is already registered.`);
  }
  registry.push({ ...entry, binding, scope: [...entry.scope] });
  reindex(entry.table);
};

/** Every encrypted column declared this process. */
export const encryptedColumns = (): readonly EncryptedColumn[] => registry;

/** A table's encrypted columns, `[]` for a table with none. */
export const encryptedColumnsOf = (table: string): readonly EncryptedColumn[] =>
  byTable.get(table) ?? NONE;

export const encryptedColumn = (table: string, column: string): EncryptedColumn | null =>
  encryptedColumnsOf(table).find((entry) => entry.column === column) ?? null;

/** Tests only: take a hand-registered column back out. */
export const unregisterEncryptedColumnForTests = (table: string, column: string): void => {
  const index = registry.findIndex((entry) => entry.table === table && entry.column === column);
  if (index >= 0) registry.splice(index, 1);
  reindex(table);
};

// ─── the context ─────────────────────────────────────────────────────────────────────────────

/** Where a value lives: everything its authenticated data binds. */
export interface ContentContext {
  readonly table: string;
  readonly column: string;
  readonly binding: ContentBinding;
  /**
   * The owner the binding names: a `citizenid`, or for a phone-bound value its `device_id` — or,
   * on a phone-bound row with no `device_id`, its `citizenid` (see `ownerOf`).
   */
  readonly owner: string;
  /**
   * For a phone-bound value: whether `owner` is a device id or the citizenid standing in. For a
   * row-bound one, `row`: `owner` is the row's seal key.
   */
  readonly ownerKind: 'citizen' | 'device' | 'row';
  readonly scope: readonly (string | number | null)[];
}

/** The columns a row must carry for its encrypted values to be sealed or opened. */
export const contextColumns = (entry: EncryptedColumn): string[] =>
  entry.binding === 'device'
    ? ['device_id', 'citizenid', ...entry.scope]
    : entry.binding === 'row'
      ? [SEAL_KEY_COLUMN, ...entry.scope]
      : ['citizenid', ...entry.scope];

const contextValue = (
  entry: EncryptedColumn,
  row: object,
  name: string
): string | number | null => {
  const value = (row as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new Error(
      `[contentCipher] ${entry.table}.${entry.column}: the row has no '${name}', which its ` +
        'authenticated data binds. Select it alongside the column.'
    );
  }
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
};

/**
 * The context for one row's value, read off the row itself.
 *
 * Throws when the row lacks a column the context needs. A missing column is a query that forgot
 * to select it, and guessing would seal a value no reader could open, or open none of them.
 */
export const contentContext = (entry: EncryptedColumn, row: object): ContentContext => {
  const scope = entry.scope.map((name) => contextValue(entry, row, name));
  const text = (value: string | number | null): string => (value === null ? '' : String(value));
  if (entry.binding === 'row') {
    // No seal key, no owner: a row-bound value is never sealed to an empty one, which every
    // such row would share. A row written before its table had the column has to get one first.
    const key = contextValue(entry, row, SEAL_KEY_COLUMN);
    if (key === null || key === '') {
      throw new Error(
        `[contentCipher] ${entry.table}.${entry.column}: the row has no ${SEAL_KEY_COLUMN}, ` +
          'which a row-bound value is sealed to.'
      );
    }
    return {
      table: entry.table,
      column: entry.column,
      binding: 'row',
      owner: text(key),
      ownerKind: 'row',
      scope
    };
  }
  if (entry.binding !== 'device') {
    return {
      table: entry.table,
      column: entry.column,
      binding: 'citizen',
      owner: text(contextValue(entry, row, 'citizenid')),
      ownerKind: 'citizen',
      scope
    };
  }
  /**
   * A phone-bound row with no `device_id` — one written before phones were items, which no
   * phone's read reaches — binds to its own `citizenid` instead, tagged so it can never be
   * mistaken for a device id. That citizenid is as fixed as a device id would be: nothing in
   * micaOS rewrites a device-owned row's `citizenid` (MICA-436), and nothing assigns a phone to
   * a row with none. Code that ever does either must re-seal the row's values under its new
   * owner first, or they stop opening.
   *
   * Not one shared empty owner for every such row: a value moved between two players' rows
   * would then still open, which is the move the owner in the AAD exists to stop.
   */
  const device = contextValue(entry, row, 'device_id');
  const ownerKind = device === null || device === '' ? 'citizen' : 'device';
  return {
    table: entry.table,
    column: entry.column,
    binding: 'device',
    owner: ownerKind === 'device' ? text(device) : text(contextValue(entry, row, 'citizenid')),
    ownerKind,
    scope
  };
};

/**
 * NUL-separated, so no two contexts can run together into the same bytes. A citizen-bound value
 * reads exactly as it did before MICA-431 — the domain, the table, the column, the citizenid,
 * the scope — so every value sealed then still opens (`contentCipher.test.ts` pins the bytes).
 * A phone-bound one has its own domain, and says which kind of owner it names.
 */
const aadOf = (context: ContentContext): Bytes =>
  Buffer.from(
    [
      context.binding === 'device'
        ? AAD_DEVICE_DOMAIN
        : context.binding === 'row'
          ? AAD_ROW_DOMAIN
          : AAD_DOMAIN,
      context.table,
      context.column,
      ...(context.binding === 'citizen' ? [] : [context.ownerKind]),
      context.owner,
      ...context.scope.map((value) => (value === null ? '' : String(value)))
    ].join('\0'),
    'utf8'
  );

/** Tests only: the authenticated data a context binds, as the bytes `aadOf` gives. */
export const __aadForTests = (context: ContentContext): string => aadOf(context).toString('utf8');

// ─── the keyring ─────────────────────────────────────────────────────────────────────────────

type Keyring =
  | { kind: 'none' }
  | { kind: 'loaded'; path: string; active: string; keys: ReadonlyMap<string, Bytes> }
  | { kind: 'refused'; path: string; reason: string };

/** A keyring file that cannot be used. The message never carries key material. */
export class KeyringError extends Error {}

/**
 * Parse a keyring file's text into its keys, first (active) first.
 *
 * Refuses anything it does not fully understand — a bad id, a key that is not exactly 32
 * bytes of base64, a repeated id, a file with no key at all. A refusal names the line, never
 * the key on it.
 */
export const parseKeyring = (text: string): { kid: string; key: Bytes }[] => {
  const keys: { kid: string; key: Bytes }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const where = `line ${i + 1}`;
    if (parts.length !== 2) {
      throw new KeyringError(`${where} is not '<kid> <base64 key>'.`);
    }
    const [kid, encoded] = parts;
    if (!KID_PATTERN.test(kid)) {
      throw new KeyringError(`${where}: a key id is 1-16 of a-z, 0-9 and '-'.`);
    }
    if (encoded.length % 4 !== 0 || !BASE64_CHAR_PATTERN.test(encoded)) {
      throw new KeyringError(`${where}: the key '${kid}' is not base64.`);
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new KeyringError(`${where}: the key '${kid}' is not ${KEY_BYTES} bytes.`);
    }
    if (keys.some((existing) => existing.kid === kid)) {
      throw new KeyringError(`${where}: the key id '${kid}' is used twice.`);
    }
    keys.push({ kid, key });
  }
  if (keys.length === 0) throw new KeyringError('the file holds no key.');
  return keys;
};

const isWindows = (): boolean => platform === 'win32';

/** `C:\…`, `C:/…`, `\\server\share` on Windows; `/…` everywhere. */
const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');

/** Forward slashes, no repeats, no trailing one; lower-cased on Windows, which ignores case. */
const normalise = (path: string): string => {
  const slashed = path
    .replace(/\\/g, '/')
    .replace(/(.)\/{2,}/g, '$1/')
    .replace(/\/+$/, '');
  return isWindows() ? slashed.toLowerCase() : slashed;
};

/** `path` with its directory's symlinks and `..` resolved, and its last part left as written. */
const linkPathOf = (path: string): string => {
  const slashed = path.replace(/\\/g, '/');
  const cut = slashed.lastIndexOf('/');
  if (cut > 0) {
    try {
      return normalise(`${realpathSync(slashed.slice(0, cut))}/${slashed.slice(cut + 1)}`);
    } catch {
      // The directory does not exist; compare what was written.
    }
  }
  return normalise(path);
};

/** Every symlink and `..` resolved where the path exists — where the bytes really are. */
const realPathOf = (path: string): string => {
  try {
    return normalise(realpathSync(path));
  } catch {
    return linkPathOf(path);
  }
};

const isInside = (child: string, parent: string): boolean =>
  parent !== '' && (child === parent || child.startsWith(`${parent}/`));

/** micaOS's own resource folder on disk, or null outside FXServer. */
const resourceRoot = (): string | null => {
  if (typeof GetResourcePath !== 'function') return null;
  return GetResourcePath(GetCurrentResourceName()) || null;
};

/** The resource that holds the content key: one of its own, never micaOS's (MICA-303). */
export const KEY_RESOURCE = 'mica-keys';
export const KEY_FILE_NAME = 'mica-content.key';

/**
 * server-data as FXServer reports it: the folder holding the `resources/` that micaOS's own
 * folder sits in, or null when micaOS's path has no `resources/` in it.
 */
export const serverDataOf = (micaRoot: string | null): string | null => {
  if (!micaRoot) return null;
  const slashed = micaRoot
    .replace(/\\/g, '/')
    .replace(/(.)\/{2,}/g, '$1/')
    .replace(/\/+$/, '');
  const cut = slashed.lastIndexOf('/resources/');
  return cut > 0 ? slashed.slice(0, cut) : null;
};

/** Where `micacrypt keygen` suggests the key file goes, under `serverData`. */
export const suggestedKeyFile = (serverData: string): string =>
  `${serverData}/resources/[local]/${KEY_RESOURCE}/${KEY_FILE_NAME}`;

/**
 * What is wrong with where a key file lives, each as a sentence for the console.
 *
 * - **Inside micaOS's own folder** — the file, or a symlink to it: an update replaces that
 *   folder, and the key or the link with it. A resource of its own (`mica-keys`) is the
 *   expected home and says nothing.
 * - **Really inside server-data**, once every symlink is followed: that directory is what gets
 *   backed up, usually beside the database dump this key exists to make useless. A symlink in
 *   `mica-keys` to a key kept outside is the best layout there is, and says nothing.
 * - **Readable by group or world**: any other account on the box can copy it.
 *
 * Warnings rather than refusals: a key in a poor place still beats plaintext, and an owner
 * who reads the warning can move it without anything having been lost.
 */
export const keyFileWarnings = (
  path: string,
  where: { micaRoot: string | null; serverData: string | null; mode: number | null }
): string[] => {
  const out: string[] = [];
  const link = linkPathOf(path);
  const real = realPathOf(path);
  const mica = where.micaRoot ? realPathOf(where.micaRoot) : '';
  const serverData = where.serverData ? realPathOf(where.serverData) : '';
  if (isInside(link, mica) || isInside(real, mica)) {
    out.push(
      `the content key file ${path} is inside micaOS's own resource folder, which an update ` +
        `replaces, and the key with it. Move it into a resource of its own, ${KEY_RESOURCE} ` +
        '(micacrypt keygen prints the layout).'
    );
  } else if (isInside(real, serverData)) {
    out.push(
      `the content key file ${path} ${real === link ? 'is' : `leads to ${real}, which is`} ` +
        'inside server-data, so every backup of server-data carries it beside the database it ' +
        'protects. Keep the key outside server-data and leave a symlink to it in its place.'
    );
  }
  if (where.mode !== null && (where.mode & 0o077) !== 0) {
    out.push(
      `the content key file ${path} is readable by other accounts on this machine ` +
        `(mode ${(where.mode & 0o777).toString(8)}). chmod 600 it.`
    );
  }
  return out;
};

/**
 * server-data: worked out from micaOS's own resource path where it runs inside `resources/`,
 * which is what FXServer itself reports, and the directory the server started in otherwise.
 */
export const serverDataDir = (): string | null => {
  const fromResource = serverDataOf(resourceRoot());
  if (fromResource !== null) return fromResource;
  try {
    return cwd();
  } catch {
    return null;
  }
};

const modeOf = (path: string): number | null => {
  if (isWindows()) return null;
  try {
    return statSync(path).mode;
  } catch {
    return null;
  }
};

let keyring: Keyring | null = null;

/**
 * Why a key file that is there can still be unreadable, for the refusal: FXServer's own
 * sandbox, which no `server.cfg` line lifts (measured on a real FXServer, MICA-302).
 */
const SANDBOX_RULE =
  'or FXServer will not let micaOS read it: a resource may read only files inside a resource ' +
  `folder. Put the key in a resource of its own, ${KEY_RESOURCE}; micacrypt keygen prints the ` +
  'layout.';

/** Read the convar, then the file, once. Never throws: a refusal is a state, not an error. */
const loadKeyring = (): Keyring => {
  const path = GetConvar('mica_content_key_file', '').trim();
  if (path === '') return { kind: 'none' };
  if (!isAbsolutePath(path)) {
    return { kind: 'refused', path, reason: 'mica_content_key_file must be an absolute path.' };
  }
  let text: string;
  try {
    if (!existsSync(path)) {
      return { kind: 'refused', path, reason: `the file does not exist, ${SANDBOX_RULE}` };
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      kind: 'refused',
      path,
      reason: `the file could not be read (${String(error)}), ${SANDBOX_RULE}`
    };
  }
  let keys: { kid: string; key: Bytes }[];
  try {
    keys = parseKeyring(text);
  } catch (error) {
    return {
      kind: 'refused',
      path,
      reason: error instanceof KeyringError ? error.message : 'the file could not be parsed.'
    };
  }
  for (const warning of keyFileWarnings(path, {
    micaRoot: resourceRoot(),
    serverData: serverDataDir(),
    mode: modeOf(path)
  })) {
    console.warn(`[micaOS] ${warning}`);
  }
  return {
    kind: 'loaded',
    path,
    active: keys[0].kid,
    keys: new Map(keys.map(({ kid, key }) => [kid, key]))
  };
};

const currentKeyring = (): Keyring => {
  if (keyring === null) keyring = loadKeyring();
  return keyring;
};

/** The id of the key new values are sealed with, or null when there is none to seal with. */
export const activeKeyId = (): string | null => {
  const ring = currentKeyring();
  return ring.kind === 'loaded' ? ring.active : null;
};

/** Every key id the keyring can open, active first; `[]` without a usable keyring. */
export const loadedKeyIds = (): string[] => {
  const ring = currentKeyring();
  return ring.kind === 'loaded' ? [...ring.keys.keys()] : [];
};

/** Bound into every digest key's derivation, beside the caller's purpose. */
const DIGEST_DOMAIN = 'micaOS digest v1';

/**
 * Derived digest keys, per content key and purpose. Held by the key's own bytes, weakly, so a
 * keyring read again (a test's reset) can never be answered from a key it no longer holds.
 */
const digestKeys = new WeakMap<Bytes, Map<string, Bytes>>();

const digestKey = (key: Bytes, purpose: string): Bytes => {
  let byPurpose = digestKeys.get(key);
  if (!byPurpose) {
    byPurpose = new Map();
    digestKeys.set(key, byPurpose);
  }
  let derived = byPurpose.get(purpose);
  if (!derived) {
    derived = createHmac('sha256', key).update(`${DIGEST_DOMAIN}\u0000${purpose}`).digest();
    byPurpose.set(purpose, derived);
  }
  return derived;
};

/**
 * A keyed digest of `value` under every loaded key, active first, each with its key id: for a
 * value that must be found again by equality and never read back — the import ledger's key for
 * a message, built from its body (MICA-340).
 *
 * HMAC-SHA-256 under a key derived from the content key per `purpose` (itself an HMAC of the
 * domain and the purpose), never the content key as it is: the AES key is not reused as a MAC
 * key, and two purposes never share a digest. The key stays in this module; what leaves it is
 * the id and the digest. `[]` with no usable keyring, none or refused — the caller decides what
 * an unkeyed value becomes, as it decides for a write.
 */
export const contentDigests = (
  purpose: string,
  value: string
): { kid: string; digest: Bytes }[] => {
  const ring = currentKeyring();
  if (ring.kind !== 'loaded') return [];
  return [...ring.keys].map(([kid, key]) => ({
    kid,
    digest: createHmac('sha256', digestKey(key, purpose)).update(value).digest()
  }));
};

// ─── the enabled marker ──────────────────────────────────────────────────────────────────────

/**
 * The ledger row that says this database holds ciphertext, written before the first sealed
 * value is handed back to be stored.
 *
 * In `mica_schema_migrations`, for the reason `contentRetention.ts` keeps its grace markers
 * there: the one server-owned `id → timestamp` table, read by the migration runner only for ids
 * a file carries, which `content-cipher:` cannot collide with.
 *
 * The table name is written out rather than imported from `schemaSql.ts`: `defineService`
 * imports this module, and `schemaSql` imports `defineService`.
 */
const LEDGER = 'mica_schema_migrations';
export const CONTENT_CIPHER_MARKER_ID = 'content-cipher:enabled';

/** null until asked. Once true it stays true: the marker is never removed. */
let enabled: boolean | null = null;

const firstNumber = (rows: unknown, column: string): number => {
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  return Number(row?.[column] ?? 0) || 0;
};

/**
 * Whether anything has ever been sealed in this database.
 *
 * No ledger means no: nothing can have been sealed without writing the marker first, and the
 * marker cannot be written without the ledger. A database error is not an answer and throws —
 * the caller is about to write, and the write would fail the same way.
 */
export const contentEncryptionEnabled = async (): Promise<boolean> => {
  if (enabled !== null) return enabled;
  const ledger = firstNumber(
    await Database.query(
      'SELECT COUNT(*) AS `n` FROM information_schema.TABLES ' +
        'WHERE `table_schema` = DATABASE() AND `table_name` = ?',
      [LEDGER]
    ),
    'n'
  );
  const found =
    ledger > 0 &&
    firstNumber(
      await Database.query(`SELECT COUNT(*) AS \`n\` FROM \`${LEDGER}\` WHERE \`id\` = ?`, [
        CONTENT_CIPHER_MARKER_ID
      ]),
      'n'
    ) > 0;
  enabled = found;
  return found;
};

/** Record the marker. Throws when it cannot, so no ciphertext is ever stored unrecorded. */
const recordEnabled = async (): Promise<void> => {
  if (enabled === true) return;
  try {
    await Database.query(`INSERT IGNORE INTO \`${LEDGER}\` (\`id\`) VALUES (?)`, [
      CONTENT_CIPHER_MARKER_ID
    ]);
  } catch (error) {
    sayOnce(
      'marker',
      `[micaOS] content encryption: could not record that this database holds ciphertext in ` +
        `${LEDGER} (${reasonOf(error, NO_REASON)}). Run micaschema apply; until then, writes of encrypted ` +
        'columns are refused.'
    );
    throw new Error('content encryption: the enabled marker could not be recorded.', {
      cause: error
    });
  }
  enabled = true;
};

// ─── seal and open ───────────────────────────────────────────────────────────────────────────

const said = new Set<string>();
const sayOnce = (key: string, line: string, level: 'warn' | 'error' = 'error'): void => {
  if (said.has(key)) return;
  said.add(key);
  if (level === 'warn') console.warn(line);
  else console.error(line);
};

/**
 * The keyring a write must be sealed with, or null when it is stored as plaintext. Throws where
 * a write is refused: a key file that cannot be used, or no key after something was sealed.
 */
const sealingKeyring = async (): Promise<Extract<Keyring, { kind: 'loaded' }> | null> => {
  const ring = currentKeyring();
  if (ring.kind === 'refused') {
    sayOnce(
      'refused-seal',
      `[micaOS] content encryption: the key file ${ring.path} is unusable (${ring.reason}) ` +
        'Writes of message, DM and mail bodies are refused until it is fixed.'
    );
    throw new Error('content encryption: the key file is unusable.');
  }
  if (ring.kind === 'loaded') return ring;
  if (await contentEncryptionEnabled()) {
    sayOnce(
      'missing-key',
      '[micaOS] content encryption: this database holds encrypted content, but ' +
        'mica_content_key_file is not set. Writes of message, DM and mail bodies are refused ' +
        'until the key file is back.'
    );
    throw new Error('content encryption: the key is missing.');
  }
  return null;
};

/**
 * Seal a value for storage, asking for its context only when there is a key to seal with.
 *
 * For a write that does not have the row in hand — an update by id — so that a server with no
 * key spends no query finding a context it would not use. `resolveContext` answering null (the
 * row is gone) answers null.
 *
 * - With a key: the sealed form, after the enabled marker is on record and the live column
 *   is known to hold it.
 * - Without one, before anything was ever sealed: the plaintext, unchanged.
 * - Without one, after something was: a throw. The write is refused (the player is told
 *   generically) rather than storing plaintext beside ciphertext.
 * - With a key file that cannot be used: a throw, whatever the marker says.
 *
 * **Any string seals, a sealed-looking one included.** The stored form is unambiguous — a
 * reader opens it exactly once and gets back the text that went in, `$mc1$…` and all — so a
 * player who types the prefix loses nothing, and nothing someone else wrote (a Blab quoted into
 * a report preview) can make a write fail. Only where the value would be stored **bare** — no
 * key, nothing ever sealed — is a sealed-looking one refused, with a `PlayerFacingError`:
 * stored as it is, it would read as a padlock and the backfill would take it for ciphertext.
 * A writer that must not fail on someone else's text passes it through `storablePlaintext`
 * first.
 */
export const sealContentWith = async (
  plaintext: string,
  resolveContext: () => Promise<ContentContext | null>
): Promise<string | null> => {
  if (typeof plaintext !== 'string') {
    throw new TypeError('[contentCipher] an encrypted column holds text only.');
  }
  const ring = await sealingKeyring();
  if (ring === null) {
    if (isSealed(plaintext)) {
      throw new PlayerFacingError("That text can't be saved: it starts with a reserved code.", {
        key: 'server.content.reservedPrefix'
      });
    }
    return plaintext;
  }
  const context = await resolveContext();
  if (context === null) return null;

  const key = ring.keys.get(ring.active) as Bytes;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(context));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const payload = Buffer.concat([iv, body, cipher.getAuthTag()]);
  const sealed = `${SEALED_PREFIX}${ring.active}$${payload.toString('base64')}`;
  // Fit first, marker second: a write refused as too narrow stores no ciphertext, so it must
  // not record that the database holds some — or an owner who then takes the key away would
  // find every write refused over ciphertext that does not exist.
  await assertFits(context, sealed);
  await recordEnabled();
  return sealed;
};

/**
 * A zero-width space: what `storablePlaintext` puts in front of a sealed-looking text so it is
 * stored as the plain text it is. Invisible where it is shown, and it breaks the prefix.
 */
const PREFIX_BREAK = '\u200B';

/**
 * `text`, made safe to hand to a seal that must not fail on it: unchanged when it will be
 * sealed (any string seals) or does not look sealed, and with `PREFIX_BREAK` in front when it
 * does and would be stored bare. For words the writer is carrying rather than typing — a
 * report's snapshot of a post, a script relaying a text or a mail through an export — which
 * must never be refused over what somebody else typed. Throws only where a seal would anyway:
 * an unusable key file, or no key over a database that holds ciphertext.
 *
 * `maxChars` is the bound the column's rule holds the value to. The break is one character, so
 * a text already at the bound loses its last character to make room for it — only a text that
 * is both at the limit and starts like a sealed value, on a server with no key.
 */
export const storablePlaintext = async (text: string, maxChars?: number): Promise<string> => {
  if (!isSealed(text)) return text;
  if ((await sealingKeyring()) !== null) return text;
  let kept = text;
  if (maxChars !== undefined && kept.length + PREFIX_BREAK.length > maxChars) {
    kept = kept.slice(0, Math.max(0, maxChars - PREFIX_BREAK.length));
    // Never leave half a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  }
  return `${PREFIX_BREAK}${kept}`;
};

/** Seal a value for storage in the column `context` names. See `sealContentWith`. */
export const sealContent = async (context: ContentContext, plaintext: string): Promise<string> =>
  (await sealContentWith(plaintext, async () => context)) as string;

/**
 * How many characters each live column holds, `table.column` → width, once the database has
 * said. One too narrow for a value is asked again the next time, and one it would not give is
 * not kept at all — see `assertFits`.
 */
const liveWidths = new Map<string, number>();

/** When a column whose width could not be read may be asked again. */
const widthRetryAt = new Map<string, number>();

/** How long a failed width probe waits before it is tried again. */
const WIDTH_RETRY_MS = 60_000;

/** The live width of one column, or null when the database will not give it. */
const probeWidth = async (context: ContentContext): Promise<number | null> => {
  try {
    const rows = await Database.query<Record<string, unknown>[]>(
      'SELECT `CHARACTER_MAXIMUM_LENGTH` AS `chars`, `CHARACTER_OCTET_LENGTH` AS `bytes` ' +
        'FROM information_schema.COLUMNS ' +
        'WHERE `table_schema` = DATABASE() AND `table_name` = ? AND `column_name` = ?',
      [context.table, context.column]
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const bounds = [Number(row?.chars), Number(row?.bytes)].filter(
      (n) => Number.isFinite(n) && n > 0
    );
    return bounds.length > 0 ? Math.min(...bounds) : null;
  } catch {
    return null;
  }
};

/**
 * Refuse a sealed value its live column cannot hold.
 *
 * A sealed value is longer than its plaintext, and a DM body or a report preview only has room
 * for it once `micaschema apply` has run migration 0007. Before that, a strict server errors on
 * the insert — but a non-strict one **silently truncates** it, and a truncated ciphertext is a
 * padlock forever. So the live width is read and the write refused, loudly, rather than handed
 * to that.
 *
 * A width that fits is kept for the process. One that does not is **asked again** before each
 * refusal rather than believed: `micaschema apply` widens the column on a running server, and a
 * refusal cached until restart would keep telling the owner to run the command they just ran.
 * A refused write costs one small read, and only while the column is still narrow.
 *
 * A width the database will not give (no such column yet, a driver that answers oddly) lets the
 * write through to fail or succeed on its own — the insert is still the authority — but is
 * never believed for long: it is not cached, it is asked again at most once a minute, and each
 * failed ask is an error in the console, because until it answers nothing stands between a
 * non-strict server and a truncated ciphertext.
 */
const assertFits = async (context: ContentContext, sealed: string): Promise<void> => {
  const key = `${context.table}.${context.column}`;
  let width: number | null = liveWidths.get(key) ?? null;
  const known = width !== null;
  const mayProbe = Date.now() >= (widthRetryAt.get(key) ?? 0);
  if (mayProbe && (!known || sealed.length > (width as number))) {
    // A re-ask of a known width that fails keeps the known one: the column did not get wider
    // because the database stopped answering, and the fit check must not switch off for it.
    width = (await probeWidth(context)) ?? width;
  }
  if (width !== null) {
    liveWidths.set(key, width);
    widthRetryAt.delete(key);
  } else {
    // Not cached: a failed probe is asked again, at most once a minute, and said each time,
    // because until it answers nothing stops a non-strict server truncating a sealed value.
    liveWidths.delete(key);
    if (mayProbe) {
      widthRetryAt.set(key, Date.now() + WIDTH_RETRY_MS);
      console.error(
        `[micaOS] content encryption: could not read the width of ${key}; sealed values are ` +
          'written without checking they fit until it can be read (asking again in a minute).'
      );
    }
    return;
  }
  if (sealed.length > width) {
    sayOnce(
      `narrow:${key}`,
      `[micaOS] content encryption: ${key} holds ${width} characters, too few for its sealed ` +
        'form. Run micaschema apply; until then these writes are refused.'
    );
    throw new Error(`content encryption: ${key} is too narrow for a sealed value.`);
  }
};

const unreadable = (context: ContentContext, rowId: unknown, why: string): string => {
  sayOnce(
    `unreadable:${context.table}:${rowId === undefined || rowId === null ? '?' : String(rowId)}`,
    `[micaOS] content encryption: ${context.table}.${context.column} row ` +
      `${rowId === undefined || rowId === null ? '(unknown id)' : String(rowId)} will not open ` +
      `(${why}); shown as a padlock.`,
    'warn'
  );
  return UNREADABLE_CONTENT;
};

/** A stored value opened, or the reason it would not open. */
type Opened = { text: string } | { why: string };

const openOrWhy = (context: ContentContext, stored: string): Opened => {
  if (!isSealed(stored)) return { text: stored };
  const kid = sealedKeyId(stored);
  if (kid === null) return { why: 'malformed' };
  const encoded = stored.slice(SEALED_PREFIX.length + kid.length + 1);
  if (encoded.length % 4 !== 0 || !BASE64_CHAR_PATTERN.test(encoded)) return { why: 'malformed' };
  const ring = currentKeyring();
  const key = ring.kind === 'loaded' ? ring.keys.get(kid) : undefined;
  if (!key) return { why: `no key '${kid}' is loaded` };
  const payload = Buffer.from(encoded, 'base64');
  if (payload.length < IV_BYTES + TAG_BYTES) return { why: 'malformed' };
  try {
    const decipher = createDecipheriv(ALGORITHM, key, payload.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES
    });
    decipher.setAAD(aadOf(context));
    decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)),
      decipher.final()
    ]);
    return { text: plain.toString('utf8') };
  } catch {
    return { why: 'it does not authenticate' };
  }
};

/**
 * The plaintext of a stored value, or **null** when it is sealed and will not open.
 *
 * For a caller that must tell "did not open" from "opened, and the text is a padlock" — the
 * backfill, which must never rewrite a value it could not read. Says nothing to the console;
 * `openContent` is the reader's form, which does. Plaintext (no prefix) comes back unchanged.
 */
export const tryOpenContent = (context: ContentContext, stored: string): string | null => {
  const opened = openOrWhy(context, stored);
  return 'text' in opened ? opened.text : null;
};

/**
 * The plaintext of a stored value, for showing to a reader.
 *
 * Plaintext (no prefix) comes back unchanged. A sealed value that will not open — an unknown
 * key, a context it was not sealed for, a damaged payload — comes back as
 * `UNREADABLE_CONTENT`, logged once per table and row. Never throws for what is stored.
 */
export const openContent = (context: ContentContext, stored: string, rowId?: unknown): string => {
  const opened = openOrWhy(context, stored);
  return 'text' in opened ? opened.text : unreadable(context, rowId, opened.why);
};

// ─── blind indexes (MICA-432) ───────────────────────────────────────────────────────────────

/**
 * A sealed column that something looks up or keeps unique by its value — a contact's number, a
 * Dark Chat join code, an alias — and the column beside it that holds its **blind index**: a
 * keyed digest of the value, equal for equal values and nothing else, so the database can match
 * and refuse duplicates on it without ever holding the value.
 *
 * `index` is `<kid>$<64 hex>`: HMAC-SHA-256 under a key derived from the content key for this
 * purpose alone (`contentDigests`' derivation, so it is neither the AES key nor the log salt),
 * over the table, the column, the scope's values and the normalized value, NUL-joined. The
 * scope is whatever the uniqueness is per — a contact's phone, a member's channel — so one
 * value in two scopes gives two unrelated digests, and nothing correlates across them.
 *
 * With no content key on a server that never had one, it is `plain:<normalized value>`: what a
 * plaintext lookup column held before, and no more than the plaintext beside it. `plain:` cannot
 * be a key id (`:` is outside the key id pattern), so the two forms never meet.
 */
export interface BlindIndex {
  readonly table: string;
  /** The sealed column the index is of. */
  readonly column: string;
  /** The column the index is stored in. */
  readonly index: string;
  /** The row's columns the value is unique within, bound into the digest in this order. */
  readonly scope: readonly string[];
  /** What counts as the same value: the comparison the old plaintext key made. */
  readonly normalize: (value: string) => string;
}

/** `<kid>$` and 64 hex, or `plain:` and the normalized value. The column is this wide. */
export const BLIND_INDEX_WIDTH = MAX_KID_LENGTH + 1 + 64;
export const PLAIN_INDEX_PREFIX = 'plain:';
const INDEX_PURPOSE = 'blind index v1';

const indexRegistry: BlindIndex[] = [];

/** Add an index to the registry. `defineService` calls this for every `blindIndex` column. */
export const registerBlindIndex = (entry: BlindIndex): void => {
  const bad = [entry.table, entry.column, entry.index, ...entry.scope].find(
    (name) => !IDENTIFIER.test(name)
  );
  if (bad !== undefined) {
    throw new Error(`[contentCipher] '${bad}' is not a lower_snake_case identifier.`);
  }
  if (!encryptedColumn(entry.table, entry.column)) {
    throw new Error(
      `[contentCipher] ${entry.table}.${entry.column} has a blind index but is not sealed: a ` +
        'plaintext column is looked up as it is.'
    );
  }
  if (entry.scope.includes(entry.column) || entry.scope.includes(entry.index)) {
    throw new Error(`[contentCipher] ${entry.table}.${entry.index}: the scope names the value.`);
  }
  if (blindIndexOf(entry.table, entry.column)) {
    throw new Error(`[contentCipher] ${entry.table}.${entry.column} already has a blind index.`);
  }
  indexRegistry.push({ ...entry, scope: [...entry.scope] });
};

export const blindIndexes = (): readonly BlindIndex[] => indexRegistry;

export const blindIndexesOf = (table: string): readonly BlindIndex[] =>
  indexRegistry.filter((entry) => entry.table === table);

export const blindIndexOf = (table: string, column: string): BlindIndex | null =>
  indexRegistry.find((entry) => entry.table === table && entry.column === column) ?? null;

/** Tests only: take a hand-registered index back out. */
export const unregisterBlindIndexForTests = (table: string, column: string): void => {
  const at = indexRegistry.findIndex((entry) => entry.table === table && entry.column === column);
  if (at >= 0) indexRegistry.splice(at, 1);
};

/** The digest's input: the place and the scope, then the value, NUL-joined. */
const indexInput = (entry: BlindIndex, row: object, value: string): string => {
  const values = row as Record<string, unknown>;
  const scope = entry.scope.map((name) => {
    const found = values[name];
    if (found === undefined) {
      throw new Error(
        `[contentCipher] ${entry.table}.${entry.index}: the row has no '${name}', which the ` +
          'index is scoped by. Select it alongside the value.'
      );
    }
    return found === null ? '' : String(found);
  });
  return [entry.table, entry.column, ...scope, entry.normalize(value)].join('\0');
};

const plainIndex = (entry: BlindIndex, value: string): string => {
  const plain = `${PLAIN_INDEX_PREFIX}${entry.normalize(value)}`;
  if (plain.length > BLIND_INDEX_WIDTH) {
    throw new Error(
      `[contentCipher] ${entry.table}.${entry.index}: the value is too long to index.`
    );
  }
  return plain;
};

const keyedIndex = (kid: string, key: Bytes, entry: BlindIndex, row: object, value: string) =>
  `${kid}$${createHmac('sha256', digestKey(key, INDEX_PURPOSE))
    .update(indexInput(entry, row, value))
    .digest()
    .toString('hex')}`;

/**
 * The index to store beside a value being written: under the active key, or `plain:` on a server
 * that has never had one. **Fails closed** exactly as sealing does — a key file that cannot be
 * used, or no key over a database that has held ciphertext, throws and nothing is written — and
 * a keyed index records the enabled marker first, as a sealed value does, so a server that loses
 * its key afterwards refuses rather than writing `plain:` beside keyed rows.
 */
export const blindIndexFor = async (
  entry: BlindIndex,
  row: object,
  value: string
): Promise<string> => {
  const ring = await sealingKeyring();
  if (ring === null) {
    indexInput(entry, row, value); // the same scope check a keyed write makes
    return plainIndex(entry, value);
  }
  const index = keyedIndex(ring.active, ring.keys.get(ring.active) as Bytes, entry, row, value);
  await recordEnabled();
  return index;
};

/**
 * Every form a stored index of this value can take, for `WHERE <index> IN (…)`: one per loaded
 * key, active first, and the `plain:` form a row written before the first key still carries until
 * `micacrypt backfill --apply` re-indexes it. So a lookup finds the row whichever key indexed it,
 * mid-rotation included. Fails closed as `blindIndexFor` does: with an unusable key file, or no
 * key over a database that has held ciphertext, a lookup throws rather than miss.
 */
export const blindIndexCandidates = async (
  entry: BlindIndex,
  row: object,
  value: string
): Promise<string[]> => {
  const ring = await sealingKeyring();
  if (ring === null) {
    indexInput(entry, row, value);
    return [plainIndex(entry, value)];
  }
  return [
    ...[...ring.keys].map(([kid, key]) => keyedIndex(kid, key, entry, row, value)),
    plainIndex(entry, value)
  ];
};

/** The key id an index was made under, `plain` for the no-key form, null for neither. */
export const blindIndexKeyId = (stored: unknown): string | null => {
  if (typeof stored !== 'string') return null;
  if (stored.startsWith(PLAIN_INDEX_PREFIX)) return 'plain';
  const end = stored.indexOf('$');
  return end > 0 && isKeyId(stored.slice(0, end)) ? stored.slice(0, end) : null;
};

// ─── rows ────────────────────────────────────────────────────────────────────────────────────

/**
 * A copy of `row` with every encrypted column of `table` that it carries sealed, context read
 * off the row. A null value stays null. For the insert paths, where the whole row is at hand.
 */
export const sealRow = async <R extends object>(table: string, row: R): Promise<R> => {
  const entries = encryptedColumnsOf(table);
  const values = row as Record<string, unknown>;
  if (!entries.some((entry) => values[entry.column] !== undefined)) return row;
  const out: Record<string, unknown> = { ...values };
  for (const entry of entries) {
    const value = values[entry.column];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new TypeError(`[contentCipher] ${table}.${entry.column} holds text only.`);
    }
    out[entry.column] = await sealContent(contentContext(entry, values), value);
  }
  return out as R;
};

/**
 * A copy of `row` with every encrypted column of `table` that it carries opened. Columns the
 * row does not carry are left alone; one it carries without its context columns throws — the
 * select forgot them.
 */
export const openRow = <R extends object>(table: string, row: R): R =>
  openWith(encryptedColumnsOf(table), row);

/** `openRow` with the table's columns already looked up, so a result set looks them up once. */
const openWith = <R extends object>(entries: readonly EncryptedColumn[], row: R): R => {
  if (entries.length === 0) return row;
  const values = row as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const entry of entries) {
    const value = values[entry.column];
    if (typeof value !== 'string' || !isSealed(value)) continue;
    out ??= { ...values };
    out[entry.column] = openContent(contentContext(entry, values), value, values.id);
  }
  return (out ?? row) as R;
};

/** `openRow` over a result set. A non-array (a failed query's `undefined`) passes through. */
export const openRows = <R extends object>(table: string, rows: R[]): R[] => {
  if (!Array.isArray(rows)) return rows;
  const entries = encryptedColumnsOf(table);
  // A copy either way, as it always was: a caller may sort or splice what it is handed.
  return entries.length === 0 ? rows.slice() : rows.map((row) => openWith(entries, row));
};

// ─── boot ────────────────────────────────────────────────────────────────────────────────────

/**
 * Say at resource start what content encryption will do, so the owner hears it at the console
 * rather than from a player whose message would not send.
 */
export const announceContentCipher = async (): Promise<void> => {
  const ring = currentKeyring();
  if (ring.kind === 'loaded') {
    console.log(
      `[micaOS] content encryption on: sealing with key '${ring.active}' ` +
        `(${ring.keys.size} key(s) loaded from ${ring.path}).`
    );
    return;
  }
  if (ring.kind === 'refused') {
    console.error(
      `[micaOS] content encryption: the key file ${ring.path} is unusable (${ring.reason}) ` +
        'Writes of message, DM and mail bodies are refused until it is fixed.'
    );
    return;
  }
  let holdsCiphertext = false;
  try {
    holdsCiphertext = await contentEncryptionEnabled();
  } catch (error) {
    console.error(
      `[micaOS] content encryption: could not read ${LEDGER} (${reasonOf(error, NO_REASON)}); ` +
        'the first write will ask again.'
    );
  }
  if (holdsCiphertext) {
    console.error(
      '[micaOS] content encryption: this database holds encrypted content, but ' +
        'mica_content_key_file is not set. Writes of message, DM and mail bodies are refused, ' +
        'and sealed ones read as a padlock, until the key file is back.'
    );
    return;
  }
  console.warn(
    '[micaOS] content encryption off: message, DM and mail bodies are stored in plaintext. ' +
      'Run micacrypt keygen for the steps that set a content key up.'
  );
};

/** The resource-start hook, exported so a test can prove it is the one registered. */
export const onContentCipherResourceStart = (resourceName: string): void => {
  if (resourceName !== GetCurrentResourceName()) return;
  // It reads the ledger, so after the first-start schema check (MICA-306).
  whenSchemaReady(announceContentCipher);
};

on('onResourceStart', onContentCipherResourceStart);

/** Tests only: forget the keyring, the marker and what has been said. */
export const resetContentCipherForTests = (): void => {
  keyring = null;
  enabled = null;
  said.clear();
  liveWidths.clear();
  widthRetryAt.clear();
};
