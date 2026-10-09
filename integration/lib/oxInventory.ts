// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { assert, unique } from './mica';
import { eventually } from './wait';

/**
 * What the qbx and esx runs both ask of ox_inventory and of the framework's own exports
 * (MICA-304). The two stacks differ in the framework and in nothing here: the phone item is
 * ox_inventory's, the stash is ox_inventory's, and a framework is reached through the same
 * `exports.<resource>.<name>` door. Written once, so the two runs cannot come to prove different
 * things about the one inventory.
 */

type Fn = (...args: unknown[]) => unknown;

const resourceExports = (resource: string): Record<string, Fn> => {
  const found = (exports as unknown as Record<string, Record<string, Fn> | undefined>)[resource];
  if (!found) throw new Error(`exports.${resource} is not available to this resource`);
  return found;
};

export const callOn = async <T = unknown>(resource: string, name: string, ...args: unknown[]) => {
  const fn = resourceExports(resource)[name];
  if (typeof fn !== 'function') throw new Error(`exports.${resource}.${name} is not callable`);
  try {
    return (await fn(...args)) as T;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`exports.${resource}.${name} threw: ${why}`, { cause: error });
  }
};

/** The item the wrapper makes micaOS's phone: `mica_phone_item`, which is empty (no gate) by default. */
export const phoneItem = (): string => {
  const item = GetConvar('mica_phone_item', '').trim();
  if (item === '') {
    throw new Error(
      "mica_phone_item is not set, so micaOS registered no usable item. The qbx and esx runs' " +
        'wrapper sets it to the item ox_inventory ships ("phone"); the wrapper on the box ' +
        'predates MICA-304 (reinstall scripts/deploy/mica-smoke-release.sh as ' +
        'scripts/deploy/README.md says).'
    );
  }
  return item;
};

interface Slot {
  slot: number;
  metadata: Record<string, unknown>;
}

/**
 * The item micaOS gates the phone on exists in ox_inventory's own item list, so a player can
 * hold one at all (MICA-279, MICA-280).
 */
export const phoneItemExistsInOxInventory = async (signal: {
  readonly aborted: boolean;
}): Promise<void> => {
  const item = phoneItem();
  // ox_inventory loads its item list after it starts; until then `Items` answers nothing.
  const def = await eventually(
    async () => {
      const found = await callOn<Record<string, unknown> | null>('ox_inventory', 'Items', item);
      return found && typeof found === 'object' ? found : null;
    },
    30_000,
    signal,
    `ox_inventory's item list to hold '${item}'`
  );
  assert(def.name === item, `ox_inventory answered '${String(def.name)}' for '${item}'`);
  assert(typeof def.label === 'string' && def.label !== '', `'${item}' has no label`);
  assert(def.stack === false, `'${item}' stacks, so two phones would merge into one slot`);
};

/**
 * Per-item metadata through a stash, in the shapes `readItemSlots` and `writeItemMetadata` read
 * and write (MICA-279, MICA-280, MICA-219). This is ox_inventory's half of that seam, not
 * micaOS's: `GetSlotsWithItem` answers `{ slot, metadata }` for each copy, and `SetMetadata`
 * replaces the whole table, which is why micaOS merges before it writes.
 */
export const itemMetadataRoundTripsThroughAStash = async (signal: {
  readonly aborted: boolean;
}): Promise<void> => {
  const item = phoneItem();
  await eventually(
    async () => (await callOn('ox_inventory', 'Items', item)) || null,
    30_000,
    signal,
    `ox_inventory's item list to hold '${item}'`
  );
  const stash = await callOn<string>('ox_inventory', 'CreateTemporaryStash', {
    label: 'micaOS integration',
    slots: 5,
    maxWeight: 100_000
  });
  assert(
    typeof stash === 'string' && stash !== '',
    `CreateTemporaryStash answered ${String(stash)}`
  );

  const deviceId = unique('phone');
  // Lua's `return success, response` crosses the export boundary as `[success, response]`.
  const answer = await callOn<unknown>('ox_inventory', 'AddItem', stash, item, 1, { deviceId });
  const added = Array.isArray(answer) ? answer[0] : answer;
  assert(
    added === true,
    `AddItem answered ${JSON.stringify(answer)}; expected success (true, or [true, slot])`
  );

  const slots =
    (await callOn<Slot[] | null>('ox_inventory', 'GetSlotsWithItem', stash, item)) ?? [];
  assert(
    Array.isArray(slots) && slots.length === 1,
    `the stash holds ${slots.length} phone(s), not 1`
  );
  const held = slots[0];
  assert(Number.isInteger(held.slot) && held.slot > 0, `the slot is ${String(held.slot)}`);
  assert(
    held.metadata?.deviceId === deviceId,
    `the stored deviceId is ${String(held.metadata?.deviceId)}`
  );

  // Merge, then write: what `writeItemMetadata` does, and the reason it reads first.
  await callOn('ox_inventory', 'SetMetadata', stash, held.slot, {
    ...held.metadata,
    lastUsed: 7
  });
  const again =
    (await callOn<Slot[] | null>('ox_inventory', 'GetSlotsWithItem', stash, item)) ?? [];
  assert(again.length === 1, `the stash holds ${again.length} phone(s) after the write`);
  assert(again[0].slot === held.slot, 'the write moved the item to another slot');
  assert(again[0].metadata?.deviceId === deviceId, 'the merged write dropped the deviceId');
  assert(again[0].metadata?.lastUsed === 7, 'the merged write did not store the new key');
};
