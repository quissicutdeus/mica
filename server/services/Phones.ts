// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { Database } from '../lib/Database';
import { defineService, phoneKeyedRepositories } from '../lib/defineService';
import { PlayerFacingError } from '../lib/errors';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { installPhoneResolvers } from '../lib/phoneIdentity';
import { lastUsedPhoneSlot, phoneItemName } from '../lib/phoneItem';

/**
 * The phone as a thing with an identity of its own (MICA-280, on MICA-279's seam), and the
 * thing every device-owned row belongs to (MICA-282).
 *
 * **Why this is its own table rather than `mica_phone_numbers`.** The number table is what a
 * phone *has*; this is what a phone *is*. MICA-284 moved the number onto the phone, and
 * MICA-282 moved contacts, notes, media and the rest — every table declared `deviceOwned`
 * carries a `phone_id` that points here. `citizenid` on this row, as on every one of those,
 * is **whoever holds the phone now**, and it moves with the phone: see `handOver`.
 *
 * **`claimed` is what makes the upgrade work without minting into items.** A phone id lives
 * in inventory item metadata and can only be written there at runtime, when a player holds
 * the item — SQL cannot do it. So `0002_phone_data_follows_the_phone` mints one *unclaimed*
 * phone per citizen who had rows and re-keys those rows onto it, and the first item a citizen
 * uses with no id of its own **adopts** that phone rather than minting a fresh one, so the
 * data they had lands on the item in their hand. A server whose inventory cannot carry an id
 * at all — an ungated qb server, standalone, es_extended's own inventory — keeps the
 * unclaimed phone as the citizen's *identity phone* for good: one phone per citizen, which is
 * exactly what they had before.
 *
 * **Nothing here is reachable from a client.** Every generic action is off, so this
 * declaration registers no net event at all — a phone id is minted by the server and is never
 * something a payload sets, chooses or deletes (§2.9).
 */
export interface PhoneRow {
  id: number;
  citizenid: string;
  phone_id: string;
  /** Bound to an inventory item, or still waiting for the first item its citizen uses. */
  claimed: number | boolean;
  status: string;
  updated_at?: Date | string;
}

export const phones = defineService<PhoneRow>({
  id: 'phones',
  table: 'mica_phones',
  access: { read: 'owner', write: 'server' },
  schema: {
    /**
     * 32 hex characters from `randomBytes(16)`.
     *
     * Opaque rather than the row's own `id`, because this string is written into item
     * metadata, where a player with a modified inventory can read it and any resource sharing
     * the inventory can see it. A sequential integer there would let somebody enumerate every
     * phone on the server by counting. It is **not** a secret and nothing treats it as one —
     * MICA-281 makes a phone id useless without the citizen predicate beside it — but there is
     * no reason to hand out a guessable one.
     */
    phone_id: { type: 'string', length: 32, notNull: true, clientWritable: false },
    /**
     * `0` until the phone is written into an inventory item; `1` from then on. A `tinyint`
     * rather than a nullable timestamp because MariaDB's implicit `NOT NULL` on `timestamp`
     * makes `DEFAULT NULL` a per-server question, and this needs one answer.
     */
    claimed: { type: 'bool', notNull: true, default: 0, clientWritable: false }
  },
  indexes: [
    // Uniqueness is the schema's job. Two phones sharing an id would be two players sharing a
    // phone now that MICA-282 keys rows on it.
    // Not unique on citizenid, deliberately: the whole point of MICA-219 is that a character
    // may hold several phones. `defineService` already emits a `citizenid_status` key, and a
    // lookup by citizenid alone uses its leading column, so no separate one is declared here.
    { name: 'phone_id_unique', columns: ['phone_id'], unique: true }
  ],
  options: {
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  }
});

const repo = phones.repo;

/** What a minted id looks like, and the only shape trusted off item metadata. */
const PHONE_ID = /^[0-9a-f]{32}$/;

const newPhoneId = (): string => randomBytes(16).toString('hex');

/** Who this process last confirmed holds each phone, so the hot path is not a query. */
const holderOf = new Map<string, string>();
/** The phone each citizen most recently resolved to, for rows written on their behalf. */
const activeByCitizen = new Map<string, string>();
/**
 * The phone each connected source most recently resolved to (MICA-283), for the two callers
 * that need the answer **synchronously**: `LockState` keys the external lock on it, and the
 * battery's tick loop asks which phone a live charge belongs to. Keyed by source, so cleared
 * on `playerDropped` — FiveM reuses server ids, and a stale entry would key the next player's
 * lock and charge to a phone they have never held.
 */
const activeBySource = new Map<number, string>();
/** Each citizen's identity phone, once found or minted. */
const identityByCitizen = new Map<string, string>();

/**
 * Whoever needs to move rows that `transferPhoneRows` cannot reach when a phone changes hands.
 *
 * Every table with a `phone_id` column is walked automatically through
 * `phoneKeyedRepositories`; this is for the one shape that list cannot hold — a child table
 * with no repository of its own, which is `mica_messages_participants`. `Conversations.ts`
 * registers it.
 */
type HandoverRun = (phoneId: string, citizenid: string) => Promise<unknown> | unknown;
const handoverHooks: { name: string; run: HandoverRun }[] = [];

export const onPhoneHandover = (name: string, run: HandoverRun): void => {
  handoverHooks.push({ name, run });
};

/**
 * Whoever sets a phone up the first time it exists (MICA-234) — `Contacts.ts`, which seeds the
 * owner's default contacts. Registered here rather than imported, for the reason the handover
 * hooks are: this file must not import the services that key on it.
 *
 * "New" means this server just inserted the phone's `mica_phones` row, which happens once per
 * phone id (`phone_id_unique`) and never again: nothing deletes a phone row, a handover and a
 * claim update the one that exists, and the rows `0002_phone_data_follows_the_phone` backfilled
 * were inserted by SQL, not here, so an existing player's phone is never treated as new. That
 * once-only insert is the mark — a player who deletes a seeded contact is never re-seeded,
 * because nothing re-creates the phone.
 */
type CreatedRun = (phoneId: string, citizenid: string) => Promise<unknown> | unknown;
const createdHooks: { name: string; run: CreatedRun }[] = [];

export const onPhoneCreated = (name: string, run: CreatedRun): void => {
  createdHooks.push({ name, run });
};

/** Each hook is its own failure, and none can fail the phone the row was just written for. */
const announceCreated = async (phoneId: string, citizenid: string): Promise<void> => {
  for (const hook of createdHooks) {
    try {
      await hook.run(phoneId, citizenid);
    } catch (error) {
      console.error(`[mica] new-phone hook '${hook.name}' failed for phone ${phoneId}.`, error);
    }
  }
};

/** Test seam: module state that would otherwise leak between cases. Hooks are registrations and stay. */
export const __resetPhoneState = (): void => {
  holderOf.clear();
  activeByCitizen.clear();
  activeBySource.clear();
  identityByCitizen.clear();
};

/**
 * The phone a connected source last resolved to, or null before its first resolve.
 *
 * Synchronous by design and therefore a cache, not a lookup: it answers what the last
 * `resolvePhone`/`phoneForRequest` for this source found. Every device-owned request
 * refreshes it, and so does the sync `phoneItem.ts` fires on load, use and inventory change,
 * so it is stale for at most the gap between using a phone and the server hearing about it.
 */
export const activePhoneIdOf = (src: number): string | null => activeBySource.get(src) ?? null;

on('playerDropped', () => {
  activeBySource.delete(source);
});

/** The phone a player is currently on. */
export interface ActivePhone {
  phoneId: string;
  slot: number;
}

/**
 * The phone changed hands: every row on it now belongs to whoever is holding it (MICA-282).
 *
 * This is what makes a stolen phone show its data to the thief, and it is deliberately a
 * *transfer* rather than a weaker predicate. §2.9's rule — every read and write names the
 * citizen and the phone — is untouched; what moves is which citizen the rows name. The
 * authorization is the inventory's own export having just said this player holds the item
 * carrying this id, which is the same trust the framework itself is given.
 *
 * Each table is its own statement and its own failure: a table that could not be moved is
 * logged and the rest still move, because half a handover with a line saying which half is
 * better than a phone that stays the victim's in every table because one of them errored.
 */
const handOver = async (phoneId: string, citizenid: string): Promise<void> => {
  for (const keyed of phoneKeyedRepositories) {
    try {
      await keyed.transferPhoneRows(phoneId, citizenid);
    } catch (error) {
      console.error(`[mica] could not move part of phone ${phoneId} to ${citizenid}.`, error);
    }
  }
  for (const hook of handoverHooks) {
    try {
      await hook.run(phoneId, citizenid);
    } catch (error) {
      console.error(`[mica] handover hook '${hook.name}' failed for phone ${phoneId}.`, error);
    }
  }
  console.log(`[mica] phone ${phoneId} is now held by ${citizenid}; its rows moved with it.`);
};

/**
 * Make sure the phone has a row naming this holder, without paying a query on every resolve.
 *
 * Keyed on `phone_id` rather than the row id, because the id in item metadata is all a caller
 * has. Three outcomes: no row yet, so one is created already claimed (the id is on an item);
 * a row naming somebody else, which is a handover; a row still unclaimed, which this claims.
 * A create that loses a race with a concurrent one violates `phone_id_unique`, which is the
 * correct outcome — the row exists either way, and the next resolve reads it.
 */
const ensureHeld = async (phoneId: string, citizenid: string): Promise<void> => {
  if (holderOf.get(phoneId) === citizenid) return;

  try {
    const [existing] = await repo.findAll({ phone_id: phoneId } as Partial<PhoneRow>);
    if (!existing) {
      await repo.create({ citizenid, phone_id: phoneId, claimed: 1 } as Partial<PhoneRow>);
      await announceCreated(phoneId, citizenid);
    } else {
      if (existing.citizenid !== citizenid) await handOver(phoneId, citizenid);
      if (!Number(existing.claimed)) {
        await repo.update(existing.id, { claimed: 1 } as Partial<PhoneRow>, citizenid);
      }
    }
    holderOf.set(phoneId, citizenid);
    identityByCitizen.delete(citizenid);
  } catch (error) {
    // Not fatal and not cached: the id is on the item either way, so the next resolve retries.
    console.error(`[mica] could not record the phone row for ${phoneId}`, error);
  }
};

/** The citizen's phone that is bound to no item yet, or null. Lowest id when there are several. */
const readUnclaimed = async (citizenid: string): Promise<PhoneRow | null> => {
  const rows = await repo.findAll({ citizenid, claimed: 0 } as Partial<PhoneRow>);
  if (rows.length === 0) return null;
  return rows.reduce((lowest, row) => (row.id < lowest.id ? row : lowest));
};

/**
 * The phone a citizen is on when no item can say (MICA-282).
 *
 * One phone per citizen, minted server-side and never written into an item — the shape every
 * server had before phones were items, kept for the servers that still cannot carry one: an
 * ungated qb server, standalone, es_extended's own inventory. On a gated server it is also
 * the phone the first item a citizen uses adopts, which is how the migration's backfill lands
 * on a real item; `resolvePhone` clears the cache below when that happens.
 */
export const identityPhone = async (citizenid: string): Promise<string> => {
  const known = identityByCitizen.get(citizenid);
  if (known) return known;

  const unclaimed = await readUnclaimed(citizenid);
  let phoneId: string;
  if (unclaimed) {
    phoneId = unclaimed.phone_id;
  } else {
    phoneId = newPhoneId();
    await repo.create({ citizenid, phone_id: phoneId, claimed: 0 } as Partial<PhoneRow>);
    await announceCreated(phoneId, citizenid);
  }
  identityByCitizen.set(citizenid, phoneId);
  return phoneId;
};

/**
 * The phone a citizen is on, for a row written on their behalf — a notification, a photo
 * dropped onto them, a contact a job hands them, a call logged against them.
 *
 * Their active phone when this process has resolved one; else the phone they touched most
 * recently, which a handover and a claim both move `updated_at` for; else their identity
 * phone, created if they have none at all. The middle case is an offline player on a gated
 * server: nothing is in hand to ask, and the phone they last used is the best answer there is.
 */
export const phoneForCitizen = async (citizenid: string): Promise<string> => {
  const active = activeByCitizen.get(citizenid);
  if (active) return active;

  const latest = await Database.single<{ phone_id: string } | null>(
    `SELECT \`phone_id\` FROM \`mica_phones\` WHERE \`citizenid\` = ? AND \`status\` = 'active'
     ORDER BY \`updated_at\` DESC, \`id\` DESC LIMIT 1`,
    [citizenid]
  );
  if (latest?.phone_id) return latest.phone_id;

  return await identityPhone(citizenid);
};

/**
 * What resolving a source's phone can come to, and why three answers rather than a nullable.
 *
 * MICA-280 folded every non-answer into `null`, and for its one caller that was right. The
 * number sync (MICA-284) and the request resolver (MICA-282) have to tell two of them apart: a
 * player on a gated server who holds **no** phone must be refused — they have no phone for
 * rows to belong to, and the phone is closed for them anyway — while a server that cannot
 * carry a phone id at all degrades to the citizen's identity phone. The other causes of
 * `'unavailable'` (no gate configured, no loaded character, the metadata write failed) all
 * want that same degrade.
 */
export type PhoneResolution =
  | { status: 'active'; phone: ActivePhone }
  /** A phone item is required here and this player holds none. */
  | { status: 'none' }
  /** No phone identity can be had on this server, or for this source, right now. */
  | { status: 'unavailable' };

const UNAVAILABLE: PhoneResolution = { status: 'unavailable' };

/**
 * The phone this source is using, minting one into the item the first time.
 *
 * **The rule lives here and nowhere else**, so no service re-implements it: the phone in the
 * slot this player last *used*, falling back to the lowest slot they hold. Last-used rather
 * than purely positional because a player switches phones by using one, which is visible,
 * where switching by dragging items between slots is not. `readItemSlots` returns slots
 * ascending precisely so the fallback is `slots[0]` rather than a sort somebody has to repeat.
 *
 * **An item with no id adopts the citizen's unclaimed phone before minting.** That is the
 * runtime half of the migration's backfill: the rows it re-keyed are on that phone, and the
 * first item in the player's hand is the one they should land on. Only when there is none is
 * a fresh id minted.
 *
 * **A minted id is written to the item before it is recorded**, and the resolve answers
 * `'unavailable'` if that write fails. The other order is worse: a row created for an id that
 * never reached the item is an orphan nothing will ever point at, where an id on an item with
 * no row yet is simply picked up and recorded by the next resolve.
 */
export const resolvePhone = async (src: number): Promise<PhoneResolution> => {
  const item = phoneItemName();
  if (!item) return UNAVAILABLE;

  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return UNAVAILABLE;

  const slots = FrameworkBridge.itemSlots(player, item);
  // `null` is "this inventory cannot say", never "holds none" — treating them alike would mint
  // a fresh phone on every resolve for a server that can never store one.
  if (slots === null) return UNAVAILABLE;
  if (slots.length === 0) return { status: 'none' };

  const preferred = lastUsedPhoneSlot(src);
  const chosen = slots.find((entry) => entry.slot === preferred) ?? slots[0];

  const carried = chosen.metadata.phoneId;
  if (typeof carried === 'string' && PHONE_ID.test(carried)) {
    await ensureHeld(carried, player.citizenid);
    activeByCitizen.set(player.citizenid, carried);
    activeBySource.set(src, carried);
    return { status: 'active', phone: { phoneId: carried, slot: chosen.slot } };
  }

  let adopted: string | null = null;
  try {
    adopted = (await readUnclaimed(player.citizenid))?.phone_id ?? null;
  } catch (error) {
    // A fresh id is the safe answer: nothing is lost, the unclaimed phone stays where it is.
    console.error(`[mica] could not look for ${player.citizenid}'s unclaimed phone`, error);
  }
  const phoneId = adopted ?? newPhoneId();

  if (!FrameworkBridge.setItemMetadata(player, item, chosen.slot, { phoneId })) {
    // `writeItemMetadata` has already said why, once. Claiming an id the item does not carry
    // would hand this player a different phone on their next relog.
    return UNAVAILABLE;
  }

  await ensureHeld(phoneId, player.citizenid);
  activeByCitizen.set(player.citizenid, phoneId);
  activeBySource.set(src, phoneId);
  return { status: 'active', phone: { phoneId, slot: chosen.slot } };
};

/**
 * The phone this source is using, or `null` when they have no phone identity right now.
 *
 * `resolvePhone` with its three answers folded to one, for a caller that does not need to
 * tell "holds none" from "cannot say".
 */
export const activePhone = async (src: number): Promise<ActivePhone | null> => {
  const resolution = await resolvePhone(src);
  return resolution.status === 'active' ? resolution.phone : null;
};

/**
 * The phone a request is for — what `ServiceEndpoint` asks before running a device-owned
 * action (MICA-282).
 *
 * Holding no phone on a gated server is a refusal the player can read, not a fallthrough: they
 * have no phone for rows to belong to, and the phone is closed for them anyway
 * (`phoneItem.ts`), so the only way this is reached is a client that opened it regardless.
 * Everything else that is not an item in hand degrades to the identity phone.
 */
export const phoneForRequest = async (src: number, citizenid: string): Promise<string> => {
  const resolution = await resolvePhone(src);
  if (resolution.status === 'active') return resolution.phone.phoneId;
  if (resolution.status === 'none') {
    throw new PlayerFacingError('You are not holding a phone.', { key: 'server.phone.notHeld' });
  }
  const identity = await identityPhone(citizenid);
  activeByCitizen.set(citizenid, identity);
  activeBySource.set(src, identity);
  return identity;
};

installPhoneResolvers({ forRequest: phoneForRequest, forCitizen: phoneForCitizen });
