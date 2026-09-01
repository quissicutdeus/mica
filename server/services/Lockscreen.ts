// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { randomBytes, scrypt } from 'node:crypto';
import { defineService, SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { lockscreenContract } from '@gphone/shared/contracts/lockscreen';

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

export const lockscreen = defineService<LockscreenRow, typeof lockscreenContract>({
  contract: lockscreenContract,
  id: 'lockscreen',
  // `write: 'server'` disables the generic create/update outright — nothing about this
  // row is ever written through the generic path, only through the named actions below,
  // each of which validates and hashes before anything reaches SQL.
  access: { read: 'owner', write: 'server' },
  schema: {
    // Salted scrypt, hex-encoded (64 chars for a 32-byte key). Still no runtime
    // dependency: scrypt is in `node:crypto`, which the FXServer runtime already ships.
    //
    // This comment used to argue the opposite — that a 4-6 digit PIN has too little
    // entropy for a heavier KDF to buy anything a salt does not. MICA-164 overturned it,
    // and the reasoning is in `hashPasscode` below: a salt beats a table built for every
    // player at once, and does nothing about the attacker holding one row, for whom 10,000
    // candidates against a bare digest is milliseconds of work. A small keyspace is the
    // case *for* a memory-hard KDF, not against it.
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

/**
 * scrypt, not a bare digest, and not Argon2id either.
 *
 * The old shape was one salted SHA-256 pass, on the recorded argument that "a 4-6 digit PIN
 * has so little entropy that a heavier KDF buys nothing a salt does not already buy". Half
 * of that is right — the salt does defeat a table built for every player at once — and half
 * of it is not. A salt does nothing about the attacker who has the row in front of them:
 * 10,000 candidates against one SHA-256 each is work measured in milliseconds. A memory-hard
 * KDF is precisely the tool for a small keyspace, because it prices each of those 10,000
 * guesses rather than trying to make the keyspace bigger. CodeQL flags the old shape as
 * `js/insufficient-password-hash`, and it is right to.
 *
 * scrypt rather than the Argon2id MICA-164 asked for, because Argon2id means the repo's
 * first runtime dependency — `dependencies` is empty today, `node:crypto` has no Argon2, and
 * the server is bundled, so a native binding is not even an option. scrypt is memory-hard,
 * already in the runtime, and closes the same gap. That is a deliberate deviation from the
 * ticket, recorded here rather than left for a reader to notice.
 *
 * Async throughout: see `nodeCrypto.d.ts` on why `scryptSync` would stutter the whole
 * server's tick for one player unlocking their phone.
 */
const KEY_LENGTH = 32;

/**
 * Cost, tunable because "tuned for my box" is not a defensible default for somebody else's.
 *
 * `N` is scrypt's work factor and must be a power of two; 16384 is Node's own default and
 * costs ~16MB and on the order of 50-100ms per verification, which is the right price for an
 * action a player takes when they open their phone and never in a loop. An operator on weak
 * hardware turns it down; one who cares more than we do turns it up.
 */
const COST_CONVAR = 'gphone_lockscreen_scrypt_cost';
const DEFAULT_COST = 16384;
const BLOCK_SIZE = 8;

const scryptCost = (): number => {
  const raw = Number.parseInt(GetConvar(COST_CONVAR, String(DEFAULT_COST)), 10);
  // A non-power-of-two, a zero, or a typo makes Node throw rather than quietly weaken the
  // hash — but a throw here is a player who cannot unlock their phone, so an unusable value
  // falls back to the default and says so once.
  if (!Number.isInteger(raw) || raw < 2 || (raw & (raw - 1)) !== 0) {
    console.warn(
      `[gPhone] ${COST_CONVAR} is '${GetConvar(COST_CONVAR, '')}', which is not a power of ` +
        `two of at least 2. Using ${DEFAULT_COST}.`
    );
    return DEFAULT_COST;
  }
  return raw;
};

/**
 * Stands in for a missing row's salt so the absent case costs what the present one costs.
 * Generated once per server start rather than a constant: nothing depends on its value, and
 * a fixed one in the source is a needless thing to explain.
 */
const DECOY_SALT = randomBytes(16).toString(HASH_ENCODING);

const hashPasscode = (passcode: string, salt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const N = scryptCost();
    scrypt(
      passcode,
      salt,
      KEY_LENGTH,
      // `maxmem` is derived, not chosen: Node refuses a call needing more than it, and the
      // requirement is `128 * N * r`. Doubling it leaves room for the allocator rather than
      // sitting exactly on the limit.
      { N, r: BLOCK_SIZE, p: 1, maxmem: 256 * N * BLOCK_SIZE },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey.toString(HASH_ENCODING));
      }
    );
  });

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
 * How many guesses a citizenid gets, and how long a wrong streak costs.
 *
 * The transport limiter (`lib/rateLimit.ts`) already caps every action at 60 calls per
 * player per minute, and for a PIN that is not a limit at all: 10,000 candidates at 60 a
 * minute is under three hours of unattended scripting, and 4-digit PINs are not drawn
 * uniformly. This is the purpose-built one MICA-164 asks for, and it sits on top of the
 * generic cap rather than replacing it.
 *
 * Keyed by **citizenid, not source**. FiveM recycles server ids — `rateLimit.forgetSource`
 * and `lib/shell.ts` both exist because of it — so a source-keyed lockout is one reconnect
 * away from being reset by the person it is meant to slow down.
 *
 * A successful entry clears the streak: the limit exists to price guessing, and somebody who
 * just proved they know the passcode is not guessing.
 */
const ATTEMPTS_CONVAR = 'gphone_lockscreen_max_attempts';
const DEFAULT_MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

interface AttemptRecord {
  failures: number;
  lockedUntil: number;
}

const attempts = new Map<string, AttemptRecord>();

/** Test seam, matching `__setRateLimitClock`. A lockout is all clock. */
let now: () => number = () => Date.now();
export const __setLockscreenClock = (fn?: () => number): void => {
  now = fn ?? (() => Date.now());
};
export const __resetLockscreenAttempts = (): void => attempts.clear();

const maxAttempts = (): number => {
  const raw = Number.parseInt(GetConvar(ATTEMPTS_CONVAR, String(DEFAULT_MAX_ATTEMPTS)), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_ATTEMPTS;
};

const lockedOutFor = (citizenid: string): number => {
  const record = attempts.get(citizenid);
  if (!record) return 0;
  const remaining = record.lockedUntil - now();
  return remaining > 0 ? remaining : 0;
};

const recordFailure = (citizenid: string): void => {
  const record = attempts.get(citizenid) ?? { failures: 0, lockedUntil: 0 };
  record.failures += 1;
  if (record.failures >= maxAttempts()) {
    record.lockedUntil = now() + LOCKOUT_MS;
    record.failures = 0;
  }
  attempts.set(citizenid, record);
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
  const { passcode } = data;

  const salt = randomBytes(16).toString(HASH_ENCODING);
  const hash = await hashPasscode(passcode, salt);
  await repo.upsert(citizenid, hash, salt);
  // Setting a passcode clears any standing lockout: the person who just set it is not the
  // person the lockout was slowing down.
  attempts.delete(citizenid);
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
  // A guess of the wrong shape answers `false` rather than erroring — see the contract for
  // why `check` is bounded but not patterned while `set` is both.
  const { passcode } = data;
  if (!PASSCODE_PATTERN.test(passcode)) return { ok: false };

  const waitMs = lockedOutFor(citizenid);
  if (waitMs > 0) {
    // Told plainly rather than answered `false`. A lockout the player cannot see is a lock
    // screen that looks broken, and the number leaks nothing: they already know they have
    // been guessing.
    throw new PlayerFacingError(`Too many attempts. Try again in ${Math.ceil(waitMs / 1000)}s.`);
  }

  const row = await repo.findByCitizenId(citizenid);

  /**
   * The KDF runs whether or not a row exists.
   *
   * Returning early on a missing row made "no passcode set" answer in a millisecond while a
   * real check took the full scrypt cost — a timing oracle for whether a citizenid has a
   * passcode, and by extension whether it exists at all. The absent case now pays the same
   * price against a throwaway salt, and its result is discarded.
   */
  const candidate = await hashPasscode(passcode, row?.passcode_salt ?? DECOY_SALT);
  if (!row) return { ok: false };

  const ok = timingSafeStringEqual(candidate, row.passcode_hash);
  if (ok) attempts.delete(citizenid);
  else recordFailure(citizenid);
  return { ok };
});

/** `clear` — remove the caller's own passcode. Idempotent: clearing an unset one is still `ok`. */
app.registerEvent('clear', async (source, cbId, data, citizenid) => {
  await repo.clear(citizenid);
  return { ok: true };
});
