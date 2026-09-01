// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';

/**
 * Phone numbers gPhone owns, for the servers where nothing else does.
 *
 * **Why this exists at all.** gPhone has never owned a number. On qb it reads
 * `charinfo.phone`, on ESX it tries the several field names community resources have used
 * (`esxVariable('phoneNumber' | 'phone_number' | 'phone')`), and in both cases the framework
 * is the source of truth. A standalone server has no framework and therefore no source —
 * and without one `getPlayerByPhone`, dialling, and `conversations:create` cannot resolve
 * anybody, so Phone, Messages and Contacts do not work. That is not a missing nicety; it is
 * three of the core apps.
 *
 * The cache and the reads live here in `lib/` rather than beside the declaration in
 * `services/PhoneNumbers.ts` for one structural reason: `FrameworkBridge` needs them, and
 * `services/PhoneNumbers.ts` imports `defineService`, which imports `ServiceEndpoint`, which
 * imports `FrameworkBridge`. A bridge reaching back into the service would close that
 * runtime cycle. The table's shape, its DDL and the assignment that writes to it stay in the
 * declaration, which is where the schema belongs; only what the bridge has to read is here.
 */

/**
 * The table, named once.
 *
 * The declaration in `services/PhoneNumbers.ts` sets `table` from this constant, and the
 * queries below interpolate it. Both are safe for the same reason `FrameworkBridge`'s reads
 * of `players` and `users` are: it is a frozen literal a server author wrote, never anything
 * that came off a payload. MySQL cannot parameterize an identifier (§2.9), and the only safe
 * way to build such a statement is from a closed set — one constant is the smallest closed
 * set there is, and it also means the schema and these two reads cannot drift apart.
 */
export const PHONE_NUMBERS_TABLE = 'gphone_phone_numbers';

/** One row, as the declaration defines it. */
export interface PhoneNumberRow {
  id: number;
  citizenid: string;
  number: string;
  status: string;
}

/**
 * Numbers already resolved this resource start, keyed by **citizenid**.
 *
 * `FrameworkBridge.getPlayer` is synchronous — `FrameworkPlayer.phone` is a field, and every
 * framework fills it from an object it already has in hand — while the number lives in a
 * table. A cache is what bridges those two, and it is filled by `ensureNumber` at join.
 *
 * **Keyed by identity, never by source**, which is what keeps it out of the unbounded-map
 * hazard MICA-113/114 closed. FiveM recycles server ids, so a source-keyed cache has to be
 * cleared on `playerDropped` or it will eventually hand one player another's number; a
 * citizenid-keyed one cannot go wrong that way, because the entry stays *true* forever — a
 * number is assigned once and never changes. It is therefore deliberately not cleared on
 * drop: the cost is one short string pair per distinct player who has connected since the
 * last restart, and the benefit is that a reconnecting player's number is right immediately
 * rather than after a round trip.
 */
const assigned = new Map<string, string>();

/** The number for a citizenid if it is already known, without touching the database. */
export const numberFor = (citizenid: string): string | null => assigned.get(citizenid) ?? null;

/** Record a number this process has resolved. */
export const rememberNumber = (citizenid: string, number: string): void => {
  assigned.set(citizenid, number);
};

/** Test seam. Nothing in the resource clears this — see the note on `assigned`. */
export const __resetAssignedNumbers = (): void => {
  assigned.clear();
};

/** A player's row, as the assignment path needs to see it. */
export interface AssignedNumberRow {
  id: number;
  number: string;
  status: string;
}

/**
 * A citizenid's row, **whatever status it is in**.
 *
 * Status-blind on purpose, and this is the half of MICA-151's soft-delete invariant that
 * lives outside the declaration. `citizenid_unique` is on the citizenid alone, so a row that
 * has been soft-deleted still occupies that citizenid's slot — and `lib/retention.ts` is
 * explicit that nothing in this codebase ever hard-deletes a soft-deleted row, because the
 * moderation system depends on one surviving forever. A read that filtered on
 * `status = 'active'` would therefore report "this player has no number" about a row that
 * makes issuing them one impossible, and the assignment loop would burn every attempt on a
 * constraint no new candidate can satisfy.
 *
 * The row is the player's identity rather than a piece of their content, so the right answer
 * is always to find it and use it. `ensureNumber` reactivates it; see its note.
 */
export const readAssignedRow = async (citizenid: string): Promise<AssignedNumberRow | null> => {
  if (!citizenid) return null;
  return await Database.single<AssignedNumberRow | null>(
    `SELECT \`id\`, \`number\`, \`status\` FROM \`${PHONE_NUMBERS_TABLE}\`
     WHERE \`citizenid\` = ? LIMIT 1`,
    [citizenid]
  );
};

/**
 * The stored number for a citizenid, or null when they have never been assigned one.
 *
 * Built on `readAssignedRow` rather than issuing its own narrower query, so there is one
 * definition of "this player's row" and it cannot become status-blind in one place and not
 * the other. A soft-deleted number is still that player's number — it is what
 * `findOfflineByCitizenId` should render for them, and what `ensureNumber` will hand back.
 */
export const readNumber = async (citizenid: string): Promise<string | null> => {
  const row = await readAssignedRow(citizenid);
  return row?.number ?? null;
};

/** The status a live row carries. The only other value the enum permits is `deleted`. */
export const ACTIVE_STATUS = 'active';

/** Whoever holds this number, or null. The reverse of `readNumber`, for dialling. */
export const readCitizenIdByNumber = async (number: string): Promise<string | null> => {
  if (!number) return null;
  const row = await Database.single<{ citizenid: string } | null>(
    `SELECT \`citizenid\` FROM \`${PHONE_NUMBERS_TABLE}\` WHERE \`number\` = ? LIMIT 1`,
    [number]
  );
  return row?.citizenid ?? null;
};

/**
 * The space a generated number is drawn from, and why it is shaped like this.
 *
 * **Seven digits, matching what is already in the repo.** `lib/seed.ts` writes `5550101`
 * through `5550104`, and `netGuard.phoneNumberFrom` — the only thing a number off the wire
 * passes through — trims and caps at 32 characters and normalises nothing else. So a format
 * that disagreed with the seed's would not be corrected anywhere; it would simply be a
 * second format, rendered differently in the same contact list.
 *
 * **Eight million candidates, less the reserved exchange.** A fixed `555` prefix would have
 * matched the seed most closely and left only ten thousand numbers, which a long-lived
 * server exhausts: every player who has ever connected keeps their number forever, so the
 * space has to be sized against the lifetime population rather than the concurrent one. A
 * leading digit of 2–9 keeps the number seven digits long and dialable-looking while giving
 * roughly eight million of them, at which point a collision is rare enough that the retry
 * below is a formality rather than a mechanism.
 *
 * **The whole `555` exchange is excluded, not just the four seeded numbers.** `gphoneseed`
 * owns that block, and `clearSeed` deletes contacts by `phone` together with the seeded
 * name — so a real player assigned `5550101` who happened to be saved under the matching
 * name would have that contact removed by an admin tidying up after the seed. Reserving the
 * exchange rather than the four literals also means the seed can grow without anybody
 * remembering this file exists.
 */
const FIRST_NUMBER = 2000000;
const LAST_NUMBER = 9999999;
/** `gphoneseed`'s block. Never generated. */
const RESERVED_FIRST = 5550000;
const RESERVED_LAST = 5559999;
const RESERVED_SIZE = RESERVED_LAST - RESERVED_FIRST + 1;
const SPACE = LAST_NUMBER - FIRST_NUMBER + 1 - RESERVED_SIZE;

/**
 * A random number from that space, uniformly.
 *
 * The reserved block is skipped **arithmetically** rather than by drawing again until the
 * candidate is acceptable. A reject-and-retry loop is unbounded in principle, and its
 * worst case is not a slow function but a hang: a `random` that always lands in the reserved
 * range — a stub, a broken injection — spins forever with nothing in the log. Shifting the
 * index past the block instead makes every draw succeed on its first try and keeps the
 * distribution exactly uniform.
 *
 * `Math.random` rather than a cryptographic source, deliberately. A phone number is a public
 * identifier: it is shown to every player who receives a message from it, so unpredictability
 * buys nothing — guessing somebody's number gets you the ability to text them, which is what
 * knowing it gets you anyway. What is required is *uniqueness*, and that is enforced by the
 * unique key on the column, not by the quality of this generator.
 *
 * It is also not derived from the citizenid, which was the obvious shortcut and is wrong
 * twice: a derived number leaks the license identifier's entropy into a string other players
 * are shown, and it hands the same player the same number on every server that runs gPhone.
 */
export const generatePhoneNumber = (random: () => number = Math.random): string => {
  const index = Math.floor(random() * SPACE);
  const bounded = Math.min(Math.max(index, 0), SPACE - 1);
  const candidate = FIRST_NUMBER + bounded;
  return String(candidate >= RESERVED_FIRST ? candidate + RESERVED_SIZE : candidate);
};

/**
 * Is this the unique-key violation the assignment loop expects, or a real failure?
 *
 * Told apart rather than treated alike, because the two demand opposite responses: a
 * duplicate is ordinary and means try again, while a connection error or a missing table
 * means stop and say so. A loop that retried both would turn "the table was never imported"
 * into eight identical failures and then a misleading "the number space is exhausted".
 *
 * Three shapes, because the driver is not one thing: mysql2 supplies `errno`/`code` on an
 * Error, oxmysql sometimes rejects with a bare string, and a wrapper may leave only the
 * message. Matching any of them beats matching whichever one this machine happens to produce.
 */
export const isDuplicateEntry = (error: unknown): boolean => {
  if (typeof error === 'string') return /duplicate entry/i.test(error);
  const candidate = error as { errno?: unknown; code?: unknown; message?: unknown };
  if (candidate?.errno === 1062) return true;
  if (typeof candidate?.code === 'string' && candidate.code.toUpperCase() === 'ER_DUP_ENTRY') {
    return true;
  }
  return typeof candidate?.message === 'string' && /duplicate entry/i.test(candidate.message);
};

/**
 * How many numbers to try before giving up and saying the space is full.
 *
 * Bounded rather than infinite, and loud rather than silent, because the two ways this loop
 * can fail need different answers and neither is "keep going". With roughly eight million
 * numbers, eight consecutive collisions require the space to be about half full — some four
 * million players — and at that point retrying harder is not the fix. Below that the first
 * attempt almost always wins.
 */
export const MAX_ASSIGN_ATTEMPTS = 8;
