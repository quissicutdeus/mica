// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';

/**
 * Phone numbers micaOS owns, and the phone each one belongs to (MICA-151, MICA-284).
 *
 * **Why this exists at all.** micaOS used to own no numbers: on qb it read `charinfo.phone`,
 * on ESX whichever field a community resource wrote, and standalone — with no framework to
 * issue one — got this table (MICA-151). MICA-284 turned that around for qb: **the number
 * belongs to the phone**, so stealing a phone steals its number, and micaOS is the source of
 * truth on standalone and on both qb cores. The framework's own `charinfo.phone` is kept in
 * step by a write-back through the framework's export, so every other resource on the server
 * keeps reading a number that is still right. ESX keeps the number on the character, because
 * there is no standard setter to write it back through and a number only micaOS believed
 * would be worse than one micaOS does not own; `services/PhoneNumbers.ts` says so once.
 *
 * The cache and the reads live here in `lib/` rather than beside the declaration in
 * `services/PhoneNumbers.ts` for one structural reason: `FrameworkBridge` and its adapters
 * need them, and `services/PhoneNumbers.ts` imports `defineService`, which imports
 * `ServiceEndpoint`, which imports `FrameworkBridge`. A bridge reaching back into the service
 * would close that runtime cycle. The table's shape, its DDL and the assignment that writes
 * to it stay in the declaration, which is where the schema belongs; only what the bridge has
 * to read is here.
 */

/**
 * The table, named once.
 *
 * The declaration in `services/PhoneNumbers.ts` sets `table` from this constant, and the
 * queries below interpolate it. Both are safe for the same reason `FrameworkBridge`'s reads
 * of `players` and `users` are: it is a frozen literal a server author wrote, never anything
 * that came off a payload. MySQL cannot parameterize an identifier (§2.9), and the only safe
 * way to build such a statement is from a closed set — one constant is the smallest closed
 * set there is, and it also means the schema and these reads cannot drift apart.
 */
export const PHONE_NUMBERS_TABLE = 'mica_phone_numbers';

/**
 * One row, as the declaration defines it.
 *
 * `phone_id` is the phone this number belongs to, or **`NULL` for a legacy row**: a number
 * that is this citizen's and has not yet been attached to a phone. Every row was a legacy row
 * before MICA-284, and on a server whose inventory cannot carry a phone id (standalone, or
 * es_extended's own inventory) every row stays one — one number per citizen, exactly as
 * before. `citizenid` is whoever last used the phone the number is on, which is what makes a
 * stolen phone ring for the thief.
 */
export interface PhoneNumberRow {
  id: number;
  citizenid: string;
  number: string;
  phone_id: string | null;
  status: string;
}

/**
 * The two caches, and why there are two.
 *
 * `FrameworkBridge.getPlayer` is synchronous — `FrameworkPlayer.phone` is a field, and every
 * framework fills it from an object it already has in hand — while the number lives in a
 * table. `assigned` bridges those two: citizenid to the number of the phone that citizen is
 * currently on, filled by `syncNumber` when they load, use a phone, or their inventory
 * changes. `holders` is the reverse, number to the citizen holding it, and is what
 * `getPlayerByPhone` consults before it walks every connected player's `charinfo` — because
 * on qb the `charinfo` mirror is deliberately left stale for a player whose phone was taken
 * (see `writeBack` in the service), so the walk alone would find the victim.
 *
 * **Keyed by identity, never by source**, which is what keeps them out of the unbounded-map
 * hazard MICA-113/114 closed. FiveM recycles server ids, so a source-keyed cache has to be
 * cleared on `playerDropped` or it eventually hands one player another's number; a
 * citizenid-keyed one cannot go wrong that way. They are therefore deliberately not cleared
 * on drop: the cost is one short string pair per distinct player since the last restart, and
 * the benefit is that a reconnecting player's number is right immediately.
 *
 * A number is no longer assigned once and never changed — it moves with the phone — so an
 * entry here is "true as of the last sync" rather than true forever. `rememberNumber` keeps
 * both maps consistent: a number arriving under a new holder leaves the old holder's forward
 * entry only if it pointed somewhere else.
 */
const assigned = new Map<string, string>();
const holders = new Map<string, string>();

/** The number a citizenid is currently on, if this process has resolved it. No query. */
export const numberFor = (citizenid: string): string | null => assigned.get(citizenid) ?? null;

/** Whoever this process last saw holding a number, if anyone. No query. */
export const citizenIdForNumber = (number: string): string | null => holders.get(number) ?? null;

/**
 * Record that a citizen is on this number now.
 *
 * If somebody else was recorded holding it, their forward entry is dropped: the number is
 * on a phone they no longer have, and `numberFor` answering it for them would let a
 * synchronous reader believe they are still reachable there. The framework's own field is
 * a separate question and is not touched here — see `writeBack` in the service for why a
 * player left with no phone keeps the last value the framework had.
 */
export const rememberNumber = (citizenid: string, number: string): void => {
  const previous = holders.get(number);
  if (previous && previous !== citizenid && assigned.get(previous) === number) {
    assigned.delete(previous);
  }
  assigned.set(citizenid, number);
  holders.set(number, citizenid);
};

/** Test seam. Nothing in the resource clears these — see the note on the caches. */
export const __resetAssignedNumbers = (): void => {
  assigned.clear();
  holders.clear();
};

/** A row as the assignment path needs to see it. */
export interface AssignedNumberRow {
  id: number;
  citizenid: string;
  number: string;
  status: string;
}

/**
 * A citizenid's **legacy** row — their number that is not yet on any phone — or null.
 *
 * `phone_id IS NULL` is the whole definition. Before MICA-284 every row was one of these,
 * and the migration seeds one per existing qb character, so on upgrade this is where a
 * player's number is found the first time they use a phone, and the row is then attached to
 * it rather than a fresh number issued. On a server that cannot carry a phone id every row
 * stays legacy and this is simply "their number", as it was.
 *
 * **Status-blind on purpose.** `lib/retention.ts` is explicit that nothing in this codebase
 * ever hard-deletes a soft-deleted row, so a row that ever reached `status = 'deleted'` still
 * holds this citizen's number. A read that filtered on `'active'` would report "no number"
 * about a row that then collides with the fresh one issued in its place. The row is the
 * player's identity rather than a piece of their content, so the right answer is always to
 * find it and bring it back; `claimRow` in the service does the reactivation.
 *
 * `ORDER BY id` so two legacy rows for one citizen — possible only through a race two
 * connects apart, now that `citizenid_unique` is gone — answer the same one every time.
 */
export const readLegacyRow = async (citizenid: string): Promise<AssignedNumberRow | null> => {
  if (!citizenid) return null;
  return await Database.single<AssignedNumberRow | null>(
    `SELECT \`id\`, \`citizenid\`, \`number\`, \`status\` FROM \`${PHONE_NUMBERS_TABLE}\`
     WHERE \`citizenid\` = ? AND \`phone_id\` IS NULL ORDER BY \`id\` LIMIT 1`,
    [citizenid]
  );
};

/** The number row on a phone, whoever holds it, or null when the phone has none yet. */
export const readRowByPhoneId = async (phoneId: string): Promise<AssignedNumberRow | null> => {
  if (!phoneId) return null;
  return await Database.single<AssignedNumberRow | null>(
    `SELECT \`id\`, \`citizenid\`, \`number\`, \`status\` FROM \`${PHONE_NUMBERS_TABLE}\`
     WHERE \`phone_id\` = ? LIMIT 1`,
    [phoneId]
  );
};

/**
 * The stored number for a citizenid, or null when they have never had one.
 *
 * The number of the phone they most recently used, which is what `updated_at DESC` says: a
 * row's `citizenid` moves to whoever uses the phone, and moving it touches `updated_at`. For
 * a citizen with one legacy row — every citizen, on a server that cannot carry a phone id —
 * this is simply their number. Status-blind, for the reason `readLegacyRow` gives.
 */
export const readNumber = async (citizenid: string): Promise<string | null> => {
  if (!citizenid) return null;
  const row = await Database.single<{ number: string } | null>(
    `SELECT \`number\` FROM \`${PHONE_NUMBERS_TABLE}\`
     WHERE \`citizenid\` = ? ORDER BY \`updated_at\` DESC, \`id\` DESC LIMIT 1`,
    [citizenid]
  );
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
 * second format, rendered differently in the same contact list. A number adopted from a qb
 * `charinfo` keeps whatever shape qb gave it; only the ones micaOS generates look like this.
 *
 * **Eight million candidates, less the reserved exchange.** A fixed `555` prefix would have
 * matched the seed most closely and left only ten thousand numbers, which a long-lived
 * server exhausts: every phone that has ever had a number keeps it, so the space has to be
 * sized against the lifetime population rather than the concurrent one. A leading digit of
 * 2–9 keeps the number seven digits long and dialable-looking while giving roughly eight
 * million of them, at which point a collision is rare enough that the retry is a formality.
 *
 * **The whole `555` exchange is excluded, not just the four seeded numbers.** `micaseed`
 * owns that block, and `clearSeed` deletes contacts by `phone` together with the seeded
 * name — so a real player assigned `5550101` who happened to be saved under the matching
 * name would have that contact removed by an admin tidying up after the seed. Reserving the
 * exchange rather than the four literals also means the seed can grow without anybody
 * remembering this file exists.
 */
const FIRST_NUMBER = 2000000;
const LAST_NUMBER = 9999999;
/** `micaseed`'s block. Never generated. */
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
 * are shown, and it hands the same player the same number on every server that runs micaOS.
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
 * million phones — and at that point retrying harder is not the fix. Below that the first
 * attempt almost always wins.
 */
export const MAX_ASSIGN_ATTEMPTS = 8;
