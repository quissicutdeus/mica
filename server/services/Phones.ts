// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { defineService } from '../lib/defineService';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { lastUsedPhoneSlot, phoneItemName } from '../lib/phoneItem';

/**
 * The phone as a thing with an identity of its own (MICA-280, on MICA-279's seam).
 *
 * **Why this is a new table rather than `mica_phone_numbers`, which MICA-280 asked for.**
 * That table is deliberately populated on **standalone only** — its own declaration explains
 * at length that a micaOS-owned number sitting beside qb's `charinfo.phone` would be a number
 * the phone believes and no other resource does, and that widening the gate has to happen in
 * one commit together with migrating the framework's existing numbers. Minting a phone id into
 * that table would have populated it on qb and ESX and quietly begun exactly that widening, as
 * a side effect of a slice about identity rather than about numbers.
 *
 * So the phone entity lives here, on every framework, and the number keeps whatever source of
 * truth it already had. Whether a **number** follows the phone is a real question and a
 * separate one; it belongs to the slice that is willing to answer it for qb and ESX too.
 *
 * **Nothing here is reachable from a client.** Every generic action is off, so this
 * declaration registers no net event at all — a phone id is minted by the server and is never
 * something a payload sets, chooses or deletes (§2.9).
 */
export interface PhoneRow {
  id: number;
  citizenid: string;
  phone_id: string;
  status: string;
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
    phone_id: { type: 'string', length: 32, notNull: true, clientWritable: false }
  },
  indexes: [
    // Uniqueness is the schema's job. Two phones sharing an id would be two players sharing a
    // phone once MICA-282 keys rows on it.
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

/** What a minted id looks like, and the only shape trusted off item metadata. */
const PHONE_ID = /^[0-9a-f]{32}$/;

const newPhoneId = (): string => randomBytes(16).toString('hex');

/** Phone ids this process has already confirmed have a row, so the hot path is not a query. */
const rowKnown = new Set<string>();

/** Test seam: module state that would otherwise leak between cases. */
export const __resetPhoneState = (): void => {
  rowKnown.clear();
};

/** The phone a player is currently on. */
export interface ActivePhone {
  phoneId: string;
  slot: number;
}

/**
 * Make sure a minted id has a row, without paying a query on every resolve.
 *
 * Keyed on `phone_id` rather than the row id, because the id in item metadata is all a caller
 * has. A create that loses a race with a concurrent one violates `phone_id_unique`, which is
 * the correct outcome — the row exists either way, which is all this promises.
 */
const ensureRow = async (phoneId: string, citizenid: string): Promise<void> => {
  if (rowKnown.has(phoneId)) return;

  try {
    const [existing] = await phones.repo.findAll({ phone_id: phoneId } as Partial<PhoneRow>);
    if (!existing) await phones.repo.create({ citizenid, phone_id: phoneId });
    rowKnown.add(phoneId);
  } catch (error) {
    // Not fatal and not cached: the id is on the item either way, so the next resolve retries.
    console.error(`[mica] could not record the phone row for ${phoneId}`, error);
  }
};

/**
 * The phone this source is using, minting one into the item the first time.
 *
 * **The rule lives here and nowhere else**, so no service re-implements it: the phone in the
 * slot this player last *used*, falling back to the lowest slot they hold. Last-used rather
 * than purely positional because a player switches phones by using one, which is visible,
 * where switching by dragging items between slots is not. `readItemSlots` returns slots
 * ascending precisely so the fallback is `slots[0]` rather than a sort somebody has to repeat.
 *
 * `null` has four distinct causes and every one of them means the same thing to a caller —
 * this player has no phone identity right now — so they are not distinguished in the return:
 * the server gates no phone item at all, the player is not loaded, the inventory cannot carry
 * metadata (MICA-279), or they hold no phone.
 *
 * **A minted id is written to the item before it is recorded**, and the resolve returns null
 * if that write fails. The other order is worse: a row created for an id that never reached
 * the item is an orphan nothing will ever point at, where an id on an item with no row yet is
 * simply picked up and recorded by the next resolve.
 */
export const activePhone = async (src: number): Promise<ActivePhone | null> => {
  const item = phoneItemName();
  if (!item) return null;

  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return null;

  const slots = FrameworkBridge.itemSlots(player, item);
  // `null` is "this inventory cannot say", never "holds none" — treating them alike would mint
  // a fresh phone on every resolve for a server that can never store one.
  if (slots === null || slots.length === 0) return null;

  const preferred = lastUsedPhoneSlot(src);
  const chosen = slots.find((entry) => entry.slot === preferred) ?? slots[0];

  const carried = chosen.metadata.phoneId;
  if (typeof carried === 'string' && PHONE_ID.test(carried)) {
    await ensureRow(carried, player.citizenid);
    return { phoneId: carried, slot: chosen.slot };
  }

  const minted = newPhoneId();
  if (!FrameworkBridge.setItemMetadata(player, item, chosen.slot, { phoneId: minted })) {
    // `writeItemMetadata` has already said why, once. Claiming an id the item does not carry
    // would hand this player a different phone on their next relog.
    return null;
  }

  await ensureRow(minted, player.citizenid);
  return { phoneId: minted, slot: chosen.slot };
};
