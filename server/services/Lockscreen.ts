// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from 'node:crypto';
import { defineService, SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { fields, optionalString } from '../lib/payload';

/**
 * The lock screen's passcode (MICA-60): display state, not a security boundary. Nothing
 * behind the lock is authority-bearing (`web/src/shell/state/lockScreen.ts`'s own header
 * says so), so a modified client that answers its own `checkPasscode` gains nothing it did
 * not already have. What that buys here is the freedom to keep verification simple — the
 * server is asked "is this the passcode?" and answers a bare boolean, never anything a
 * client could use to narrow down the value.
 *
 * A dedicated tiny service rather than a column on `gphone_settings` (`Settings.ts`'s
 * `findAllForPlayer` selects every key a player owns and ships the lot back to hydrate the
 * UI) — a passcode hash sitting in that table would cross the wire to its own owner on
 * every load, which is exactly the "never sent back to the client in any form" this ticket
 * asks for. One row per citizenid, reached only by the four named actions below; no
 * generic action of any kind is registered.
 */
export class LockscreenRepository extends SchemaRepository<LockscreenRow> {
  async findByCitizenId(citizenid: string): Promise<LockscreenRow | null> {
    return await Database.single<LockscreenRow>(
      `SELECT * FROM gphone_lockscreen WHERE citizenid = ?`,
      [citizenid]
    );
  }

  /**
   * One row per player, so a second `setPasscode` replaces the first rather than adding a
   * second row for the unique index to reject. `ON DUPLICATE KEY UPDATE` against
   * `citizenid_unique`, the same upsert shape `Settings.ts`'s `put` uses for the same
   * reason: two rapid writes race in a find-then-insert, and the constraint decides here
   * instead of whichever query happens to interleave first.
   */
  async upsert(citizenid: string, hash: string, salt: string): Promise<void> {
    await Database.query(
      `INSERT INTO gphone_lockscreen (citizenid, passcode_hash, passcode_salt, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', NOW(), NOW())
       ON DUPLICATE KEY UPDATE passcode_hash = VALUES(passcode_hash),
         passcode_salt = VALUES(passcode_salt), status = 'active', updated_at = NOW()`,
      [citizenid, hash, salt]
    );
  }

  /** Hard delete: an unset passcode is not a row to keep around, and there is nothing to audit. */
  async clear(citizenid: string): Promise<void> {
    await Database.query(`DELETE FROM gphone_lockscreen WHERE citizenid = ?`, [citizenid]);
  }
}

export const lockscreen = defineService<LockscreenRow>({
  id: 'lockscreen',
  // `write: 'server'` disables the generic create/update outright — nothing about this
  // row is ever written through the generic path, only through the named actions below,
  // each of which validates and hashes before anything reaches SQL.
  access: { read: 'owner', write: 'server' },
  schema: {
    // Salted SHA-256, hex-encoded (64 chars). Not a runtime dependency: `node:crypto` is
    // a Node built-in the FXServer runtime already ships, and a 4-6 digit PIN has so
    // little entropy that a heavier KDF (scrypt/argon2) buys nothing a salt does not
    // already buy against a rainbow table built for every player at once.
    passcode_hash: { type: 'string', length: 64, clientWritable: false },
    passcode_salt: { type: 'string', length: 32, clientWritable: false }
  },
  indexes: [{ name: 'citizenid_unique', columns: ['citizenid'], unique: true }],
  // No generic action survives. `get` would ship the hash back to its own owner —
  // exactly what "never sent back to the client in any form" forbids — and `delete`
  // would need a row id the client is never given. `create`/`update` are already off
  // via `write: 'server'`.
  options: { disableGet: true, disableDelete: true },
  repositoryFactory: (resolved) => new LockscreenRepository(resolved)
});

interface LockscreenRow {
  id: number;
  citizenid: string;
  passcode_hash: string;
  passcode_salt: string;
  status?: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const app = lockscreen.app;
const repo = lockscreen.repo as LockscreenRepository;

/** `4` and `6` inclusive, digits only — the ticket's own bound, enforced here rather than trusted from the client. */
const PASSCODE_PATTERN = /^\d{4,6}$/;

const HASH_ENCODING = 'hex';

const hashPasscode = (passcode: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${passcode}`).digest().toString(HASH_ENCODING);

/**
 * Constant-time over the two hex digest *strings*, rather than pulling in `Buffer` and
 * `crypto.timingSafeEqual` for it. `server/tsconfig.json` cannot load `@types/node`'s
 * ambient globals at all (`server/lib/nodeCrypto.d.ts` explains why: a hard conflict with
 * `@citizenfx/server`'s own global `exports`), so a real `Buffer` is not a type available
 * here — and a XOR-accumulate over same-length strings is the same property
 * `timingSafeEqual` provides, without needing one.
 *
 * Length is checked first and *does* short-circuit — but the length of a SHA-256 hex
 * digest is a constant (64) that never depends on the passcode, salt, or which of the two
 * strings is "the guess", so branching on it leaks nothing about the value being compared.
 * What must not branch early is the per-character comparison after that, and it does not:
 * every character position is inspected even once a mismatch is known, via OR-ing into one
 * accumulator that is tested only at the very end.
 */
const timingSafeStringEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

/**
 * `status` — whether a passcode is set, and nothing else. The lock screen shows a "set a
 * passcode" prompt or a PIN pad based on this alone; it never learns the passcode itself,
 * the hash, or the salt.
 */
app.registerEvent('status', async (source, cbId, data, citizenid) => {
  const row = await repo.findByCitizenId(citizenid);
  return { hasPasscode: row !== null };
});

/** `set` — replace (or create) the caller's own passcode. Never anyone else's: `citizenid` is the caller's own, resolved server-side. */
app.registerEvent('set', async (source, cbId, data, citizenid) => {
  const passcode = optionalString(fields(data).passcode);
  if (!passcode || !PASSCODE_PATTERN.test(passcode)) {
    throw new Error('A passcode must be 4 to 6 digits.');
  }

  const salt = randomBytes(16).toString(HASH_ENCODING);
  const hash = hashPasscode(passcode, salt);
  await repo.upsert(citizenid, hash, salt);
  return { ok: true };
});

/**
 * `check` — the one question the lock screen asks, answered as a bare boolean.
 *
 * Constant-time on purpose: `timingSafeStringEqual` rather than `===`, so a byte-by-byte
 * compare cannot leak how many leading digits of a guess were right through response
 * timing. This is the one property worth keeping even though the ticket calls the lock
 * itself display state — a timing oracle against a 4-6 digit PIN turns "not a security
 * boundary" into "a security boundary with a stopwatch attached", and the fix costs
 * nothing.
 *
 * No passcode set answers `false` rather than throwing: from the caller's point of view a
 * guess that cannot be right and a guess that is wrong look the same, and the lock screen
 * only ever calls this when `getPasscodeStatus` already said one exists.
 */
app.registerEvent('check', async (source, cbId, data, citizenid) => {
  const passcode = optionalString(fields(data).passcode);
  if (!passcode) return { ok: false };

  const row = await repo.findByCitizenId(citizenid);
  if (!row) return { ok: false };

  const candidate = hashPasscode(passcode, row.passcode_salt);
  const ok = timingSafeStringEqual(candidate, row.passcode_hash);
  return { ok };
});

/** `clear` — remove the caller's own passcode. Idempotent: clearing an unset one is still `ok`. */
app.registerEvent('clear', async (source, cbId, data, citizenid) => {
  await repo.clear(citizenid);
  return { ok: true };
});
