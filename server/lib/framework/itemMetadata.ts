// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { exposes, resource } from './runtime';

/**
 * Per-item metadata, through whatever inventory this server has (MICA-279).
 *
 * The first slice of MICA-230: a phone can only be an identity if the *item* can carry
 * something that is not its name. Until this module, micaOS's entire inventory surface was
 * `countInventoryItem` and `removeInventoryItem` — both of which read quantities, and a
 * quantity cannot tell two phones apart.
 *
 * **This is the only place that knows which inventory is installed.** Everything above it
 * asks for slots and gets slots. That is the same containment `countInventoryItem` has, and
 * it is the reason MICA-230 can re-key the whole database without a second per-framework
 * branch appearing somewhere else.
 *
 * **Support is not uniform, and this module does not pretend otherwise.**
 *
 * - **ox_inventory** — real per-slot metadata, read and write. The floor, and what qbx_core
 *   uses.
 * - **qb-inventory** — reads the item's `info` table. Writing needs `SetItemData`, which is
 *   *probed* rather than assumed: it is not in every version, and a write that silently does
 *   nothing would mint a phone id that vanishes on the next relog.
 * - **es_extended's own inventory** — quantity only. There is no metadata to read or write
 *   and no amount of work changes that.
 *
 * `null` means "this inventory cannot say", never "no slots". A caller that treats the two
 * the same mints a second phone for somebody who already has one, which is why
 * `countInventoryItem` draws the identical distinction and says so.
 */

/** One slot holding the item, with whatever that copy is carrying. */
export interface ItemSlot {
  /** The inventory's own slot number. Stable enough to write back to, not to store. */
  slot: number;
  metadata: Record<string, unknown>;
}

const reported = new Set<string>();

const reportOnce = (key: string, message: string): void => {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(message);
};

/** Test seam, like `__resetPhoneItemWarnings`. */
export const __resetItemMetadataWarnings = (): void => {
  reported.clear();
};

/** ox_inventory hands back whatever the slot carries; anything else is not a metadata table. */
const asMetadata = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asSlotNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

/**
 * Every slot holding `item`, ascending, or `null` when this inventory cannot carry metadata.
 *
 * Ascending because MICA-280's fallback rule is "the lowest slot holding a phone", and a
 * caller that had to sort this itself would be a second place that knows the rule.
 *
 * ox_inventory first, for the reason `countInventoryItem` gives: on a qbx server it *is* the
 * inventory, and the core's own `GetItemByName` reads a mirror ox maintains.
 */
export const readItemSlots = (src: number, player: any, item: string): ItemSlot[] | null => {
  if (exposes('ox_inventory', 'GetSlotsWithItem')) {
    // `GetSlotsWithItem(inv, itemName, metadata?, strict?)` answers an array, or nil for an
    // inventory or item it does not know. nil is "cannot say"; an empty array is "none held".
    const slots = resource('ox_inventory').GetSlotsWithItem(src, item);
    if (!Array.isArray(slots)) return null;

    return slots
      .map((entry: any) => {
        const slot = asSlotNumber(entry?.slot);
        return slot === null ? null : { slot, metadata: asMetadata(entry?.metadata) };
      })
      .filter((entry: ItemSlot | null): entry is ItemSlot => entry !== null)
      .sort((a: ItemSlot, b: ItemSlot) => a.slot - b.slot);
  }

  if (typeof player?.Functions?.GetItemByName === 'function') {
    // qb-inventory answers one slot, not a list — a player holding two phones is reported as
    // one here. Said out loud rather than papered over: it is a real limitation of reading
    // through the core instead of the inventory, and MICA-280's "several phones" case is
    // therefore an ox_inventory feature.
    const found = player.Functions.GetItemByName(item);
    if (!found) return [];

    const slot = asSlotNumber(found.slot);
    return slot === null ? [] : [{ slot, metadata: asMetadata(found.info) }];
  }

  const xPlayer = player?.xPlayer ?? player;
  if (typeof xPlayer?.getInventoryItem === 'function') {
    reportOnce(
      'esx',
      `[mica] es_extended's own inventory stores quantities and nothing else, so an item ` +
        `here cannot carry a phone id. Anything built on per-item identity is off on this ` +
        `server; ox_inventory is what carries it. Reported once per resource start.`
    );
    return null;
  }

  reportOnce(
    'none',
    `[mica] No inventory here can read per-item metadata (ox_inventory's GetSlotsWithItem ` +
      `or a qb player's GetItemByName). Anything built on per-item identity is off on this ` +
      `server. Reported once per resource start.`
  );
  return null;
};

/**
 * Merge `patch` into one slot's metadata. `true` only when the inventory really stored it.
 *
 * **Merged, not replaced.** ox_inventory's `SetMetadata` assigns the whole table
 * (`slot.metadata = metadata`), so writing `{ phoneId }` straight through would drop
 * `durability`, `imageurl` and anything another resource keeps there. Read, merge, write.
 *
 * The read is redone here rather than taken from the caller, because the caller's copy was
 * fetched before whatever it did in between.
 */
export const writeItemMetadata = (
  src: number,
  player: any,
  item: string,
  slot: number,
  patch: Record<string, unknown>
): boolean => {
  if (exposes('ox_inventory', 'SetMetadata')) {
    const current = readItemSlots(src, player, item)?.find((entry) => entry.slot === slot);
    if (!current) return false;

    resource('ox_inventory').SetMetadata(src, slot, { ...current.metadata, ...patch });
    return true;
  }

  // Probed, never assumed. `SetItemData` is not in every qb-inventory, and a write that
  // quietly did nothing is worse here than a refusal: MICA-280 would mint a phone id, believe
  // it was stored, and mint a different one on the next relog.
  if (exposes('qb-inventory', 'SetItemData')) {
    let wrote = true;
    for (const [key, value] of Object.entries(patch)) {
      if (!resource('qb-inventory').SetItemData(src, item, key, value)) wrote = false;
    }
    return wrote;
  }

  reportOnce(
    'write',
    `[mica] No inventory here can write per-item metadata (ox_inventory's SetMetadata or ` +
      `qb-inventory's SetItemData). An item cannot be given a phone id on this server. ` +
      `Reported once per resource start.`
  );
  return false;
};
