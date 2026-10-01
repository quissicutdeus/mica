// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer, type Bytes } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { cwd, platform } from 'node:process';
import { Database } from './Database';
import { PlayerFacingError } from './errors';

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

/** `sealedLength` for a bound in characters, at utf8mb4's worst case of four bytes each. */
export const sealedLengthForChars = (maxChars: number): number =>
  sealedLength(maxChars * MAX_BYTES_PER_CHAR);

/**
 * The most characters whose worst-case sealed form fits in `capacity` bytes — how long a
 * message may be when its column is a `text` (65,535 bytes) that now holds ciphertext.
 */
export const maxPlaintextChars = (capacity: number): number => {
  let chars = Math.max(
    0,
    Math.floor(
      (Math.floor((capacity - (SEALED_PREFIX.length + MAX_KID_LENGTH + 1)) / 4) * 3 -
        IV_BYTES -
        TAG_BYTES) /
        MAX_BYTES_PER_CHAR
    )
  );
  // The closed form rounds; the definition is the check.
  while (chars > 0 && sealedLengthForChars(chars) > capacity) chars -= 1;
  while (sealedLengthForChars(chars + 1) <= capacity) chars += 1;
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

/** One encrypted column, as its service declared it. */
export interface EncryptedColumn {
  readonly table: string;
  readonly column: string;
  /**
   * The row's own columns bound into the AAD after `citizenid`, in this order — the thread a
   * value belongs to. A value that moved to another thread would stop opening, so nothing may
   * ever rewrite one of these, or `citizenid`, on a row that holds ciphertext.
   */
  readonly scope: readonly string[];
  /** Whether the table has `updated_at`, which a rewrite of the column must pin, not move. */
  readonly hasUpdatedAt: boolean;
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const registry: EncryptedColumn[] = [];

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
  if (entry.scope.includes(entry.column) || entry.scope.includes('citizenid')) {
    throw new Error(
      `[contentCipher] ${entry.table}.${entry.column}: the scope names the column itself or ` +
        "'citizenid', which is always bound already."
    );
  }
  if (new Set(entry.scope).size !== entry.scope.length) {
    throw new Error(`[contentCipher] ${entry.table}.${entry.column}: the scope repeats a column.`);
  }
  if (encryptedColumn(entry.table, entry.column)) {
    throw new Error(`[contentCipher] ${entry.table}.${entry.column} is already registered.`);
  }
  registry.push({ ...entry, scope: [...entry.scope] });
};

/** Every encrypted column declared this process. */
export const encryptedColumns = (): readonly EncryptedColumn[] => registry;

/** A table's encrypted columns, `[]` for a table with none. */
export const encryptedColumnsOf = (table: string): readonly EncryptedColumn[] =>
  registry.filter((entry) => entry.table === table);

export const encryptedColumn = (table: string, column: string): EncryptedColumn | null =>
  registry.find((entry) => entry.table === table && entry.column === column) ?? null;

/** Tests only: take a hand-registered column back out. */
export const unregisterEncryptedColumnForTests = (table: string, column: string): void => {
  const index = registry.findIndex((entry) => entry.table === table && entry.column === column);
  if (index >= 0) registry.splice(index, 1);
};

// ─── the context ─────────────────────────────────────────────────────────────────────────────

/** Where a value lives: everything its authenticated data binds. */
export interface ContentContext {
  readonly table: string;
  readonly column: string;
  readonly citizenid: string;
  readonly scope: readonly (string | number | null)[];
}

/** The columns a row must carry for its encrypted values to be sealed or opened. */
export const contextColumns = (entry: EncryptedColumn): string[] => ['citizenid', ...entry.scope];

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
  const citizenid = contextValue(entry, row, 'citizenid');
  return {
    table: entry.table,
    column: entry.column,
    citizenid: citizenid === null ? '' : String(citizenid),
    scope: entry.scope.map((name) => contextValue(entry, row, name))
  };
};

/** NUL-separated, so no two contexts can run together into the same bytes. */
const aadOf = (context: ContentContext): Bytes =>
  Buffer.from(
    [
      AAD_DOMAIN,
      context.table,
      context.column,
      context.citizenid,
      ...context.scope.map((value) => (value === null ? '' : String(value)))
    ].join('\0'),
    'utf8'
  );

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
        `${LEDGER} (${String(error)}). Run micaschema apply; until then, writes of encrypted ` +
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
export const openRow = <R extends object>(table: string, row: R): R => {
  const entries = encryptedColumnsOf(table);
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
export const openRows = <R extends object>(table: string, rows: R[]): R[] =>
  Array.isArray(rows) ? rows.map((row) => openRow(table, row)) : rows;

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
      `[micaOS] content encryption: could not read ${LEDGER} (${String(error)}); ` +
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
  void announceContentCipher();
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
