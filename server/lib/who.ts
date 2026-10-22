// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, randomBytes } from 'node:crypto';
import { Database } from './Database';
import { reasonOf } from './sqlErrors';
import { whenSchemaReady } from './schemaReady';

/**
 * Who a log line is about, without saying (MICA-433).
 *
 * A citizenid in a server log is a player's identity in a file that is pasted into Discord,
 * shipped to a log host and read by staff who need to know only that two lines are about the
 * same person. On ESX it is the player's Rockstar licence. A phone number is the same thing
 * once anybody can dial it. `who(id)` is a short, stable stand-in: the same id gives the same
 * token on every line and across restarts, and the token gives nothing back.
 *
 * **HMAC-SHA-256 under a per-install salt**, ten hex characters, and a device id is tokened the
 * same way. The salt is drawn once and kept in `mica_schema_migrations` as `log-salt:<hex>` —
 * the server-owned `id → timestamp` table retention already keeps its grace markers in, so it
 * costs no table, column or `micaschema apply`, and the migration runner reads only the on-disk
 * ids it is missing. `loadLogSalt` has what two servers starting at once on one database do.
 *
 * Not the content key, though the ticket offered it: that key is optional, loaded or not per
 * install, and rotated by `micacrypt` — a token under it would change the day an owner turns
 * encryption on or rotates, and every earlier line would stop matching every later one. The
 * salt never rotates. Unsalted SHA-256 would not do either: a citizenid is a short, guessable
 * string, and a plain hash of one is a lookup table away from the id.
 *
 * Until the salt is read — the first moments of a start, or a suite with no database — the
 * token is taken under a salt drawn for this process alone and marked with a leading `~`, so
 * nobody correlates it with a line from another run.
 */

const SALT_PREFIX = 'log-salt:';
/** The ledger. Named here rather than imported: `schemaSql` reaches the cipher, a cycle. */
const LEDGER = 'mica_schema_migrations';
const TOKEN_HEX = 10;

/** This process's own salt, for the moments before the install's is read. */
const processSalt: Uint8Array = randomBytes(32);
let installSalt: Uint8Array | null = null;

const token = (salt: Uint8Array, value: string): string =>
  createHmac('sha256', salt).update(value).digest().toString('hex').slice(0, TOKEN_HEX);

/** Sixty-four hex characters to thirty-two bytes; the shape is checked before this is called. */
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  );

/**
 * A short stable token for a citizenid or a phone number, for a log line. Empty or missing
 * reads as `-`, so a line says "nobody" rather than hashing nothing.
 */
export const who = (value: unknown): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return '-';
  const text = String(value).trim();
  if (text === '') return '-';
  return installSalt ? token(installSalt, text) : `~${token(processSalt, text)}`;
};

const SALT_SHAPE = /^log-salt:([0-9a-f]{64})$/;

/**
 * The install's salt: the first `log-salt:` row by when it was written, then by id. Every server
 * on the database asks the same question of the same rows, so every one answers the same row.
 */
const readSalt = async (): Promise<Uint8Array | null> => {
  const rows = await Database.query<{ id: string }[]>(
    `SELECT \`id\` FROM \`${LEDGER}\` WHERE \`id\` LIKE ? ORDER BY \`applied_at\`, \`id\``,
    [`${SALT_PREFIX}%`]
  );
  for (const row of Array.isArray(rows) ? rows : []) {
    const match = SALT_SHAPE.exec(String(row.id));
    if (match) return fromHex(match[1]);
  }
  return null;
};

/**
 * Read the install's salt, minting it on first start. Never rejects: a failure leaves the
 * process salt in use and says why in one line.
 *
 * **Two servers starting on one database at once.** The mint inserts only while no `log-salt:`
 * row exists, in one statement (`INSERT … SELECT … WHERE NOT EXISTS`). Under InnoDB's default
 * `REPEATABLE READ` that statement locks the gap it read, so two at once are serialised: one
 * inserts, the other inserts nothing or is chosen as a deadlock victim, and either way it reads
 * back the first one's row. Both use one salt from the first line.
 *
 * Under `READ COMMITTED`, which takes no gap locks, both can insert. Then a server that read back
 * before the other's insert landed uses its own salt for that run, and from its next start
 * agrees with the other: every reader takes the first row by `(applied_at, id)`. The tokens it
 * printed in that first run are the one place two servers' lines do not match.
 */
export const loadLogSalt = async (): Promise<void> => {
  try {
    let salt = await readSalt();
    if (!salt) {
      try {
        await Database.query(
          `INSERT INTO \`${LEDGER}\` (\`id\`) SELECT ? FROM DUAL WHERE NOT EXISTS ` +
            `(SELECT 1 FROM \`${LEDGER}\` WHERE \`id\` LIKE ?)`,
          [`${SALT_PREFIX}${randomBytes(32).toString('hex')}`, `${SALT_PREFIX}%`]
        );
      } catch {
        // The other server's mint won the lock, or the ledger is not there: the read says which.
      }
      salt = await readSalt();
    }
    if (salt) installSalt = salt;
  } catch (error) {
    console.warn(
      "[mica] log tokens stay per-process ('~'), the install salt could not be read: " +
        reasonOf(error)
    );
  }
};

/** Tests only: forget the install salt, or set one. */
export const __setLogSaltForTests = (salt: Uint8Array | null): void => {
  installSalt = salt;
};

on('onResourceStart', (resource: string) => {
  if (resource === GetCurrentResourceName()) whenSchemaReady(() => void loadLogSalt());
});
