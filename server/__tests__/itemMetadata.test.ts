// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  query: vi.fn(async () => []),
  insert: vi.fn(),
  update: vi.fn(),
  scalar: vi.fn(async () => null),
  single: vi.fn(async () => null)
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  readItemSlots,
  writeItemMetadata,
  __resetItemMetadataWarnings
} from '../lib/framework/itemMetadata';
import { __setResourceLookup } from '../lib/framework/runtime';

/**
 * The per-item metadata seam (MICA-279), against a stubbed inventory.
 *
 * The distinction every case here turns on is `null` versus `[]`. `null` is "this inventory
 * cannot carry metadata"; `[]` is "it can, and this player holds none". MICA-280 mints a phone
 * id on the second and must not on the first, so a suite that only checked truthiness would
 * pass while the feature minted a fresh identity on every relog.
 */

const SRC = 7;
const ITEM = 'phone';

const useResources = (map: Record<string, unknown>) =>
  __setResourceLookup((name) => (map as Record<string, any>)[name]);

beforeEach(() => {
  vi.clearAllMocks();
  __resetItemMetadataWarnings();
  useResources({});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setResourceLookup();
  vi.restoreAllMocks();
});

describe('reading slots through ox_inventory', () => {
  const oxWith = (slots: unknown) =>
    useResources({ ox_inventory: { GetSlotsWithItem: vi.fn(() => slots) } });

  it('answers every slot holding the item, lowest first', () => {
    oxWith([
      { slot: 9, metadata: { phoneId: 'b' } },
      { slot: 3, metadata: { phoneId: 'a' } }
    ]);

    // Sorted here rather than by the caller, so nothing else has to know that MICA-280's
    // fallback rule is "the lowest slot".
    expect(readItemSlots(SRC, {}, ITEM)).toEqual([
      { slot: 3, metadata: { phoneId: 'a' } },
      { slot: 9, metadata: { phoneId: 'b' } }
    ]);
  });

  it('answers an empty list for a player holding none, which is not the same as null', () => {
    oxWith([]);
    expect(readItemSlots(SRC, {}, ITEM)).toEqual([]);
  });

  it('answers null when ox cannot say, rather than reading nil as none held', () => {
    // `GetSlotsWithItem` returns nil for an inventory or item it does not know.
    oxWith(undefined);
    expect(readItemSlots(SRC, {}, ITEM)).toBeNull();
  });

  it('drops a slot with no usable slot number instead of inventing one', () => {
    oxWith([
      { slot: 0, metadata: {} },
      { slot: 4, metadata: {} }
    ]);
    expect(readItemSlots(SRC, {}, ITEM)).toEqual([{ slot: 4, metadata: {} }]);
  });

  it('treats a missing or non-object metadata value as empty', () => {
    oxWith([{ slot: 2 }, { slot: 5, metadata: 'durability' }]);
    expect(readItemSlots(SRC, {}, ITEM)).toEqual([
      { slot: 2, metadata: {} },
      { slot: 5, metadata: {} }
    ]);
  });
});

describe('reading slots through a qb player', () => {
  const qbHolding = (found: unknown) => ({ Functions: { GetItemByName: vi.fn(() => found) } });

  it('reads the item info table as metadata', () => {
    const player = qbHolding({ slot: 4, info: { phoneId: 'a' } });
    expect(readItemSlots(SRC, player, ITEM)).toEqual([{ slot: 4, metadata: { phoneId: 'a' } }]);
  });

  it('answers an empty list rather than null when the player simply holds none', () => {
    expect(readItemSlots(SRC, qbHolding(null), ITEM)).toEqual([]);
  });
});

describe('an inventory that cannot carry metadata at all', () => {
  it('answers null for an ESX xPlayer, and says so once', () => {
    const player = { getInventoryItem: vi.fn() };

    expect(readItemSlots(SRC, player, ITEM)).toBeNull();
    expect(readItemSlots(SRC, player, ITEM)).toBeNull();

    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('es_extended');
  });

  it('answers null when nothing recognisable is present, and says so once', () => {
    expect(readItemSlots(SRC, {}, ITEM)).toBeNull();
    expect(readItemSlots(SRC, {}, ITEM)).toBeNull();

    expect(console.warn).toHaveBeenCalledOnce();
  });
});

describe('writing metadata', () => {
  it('merges into what the slot already carries rather than replacing it', () => {
    const SetMetadata = vi.fn();
    useResources({
      ox_inventory: {
        GetSlotsWithItem: vi.fn(() => [{ slot: 3, metadata: { durability: 80 } }]),
        SetMetadata
      }
    });

    expect(writeItemMetadata(SRC, {}, ITEM, 3, { phoneId: 'a' })).toBe(true);

    // ox_inventory's SetMetadata assigns the whole table, so a straight-through write would
    // have destroyed `durability` — and nothing would have reported it.
    expect(SetMetadata).toHaveBeenCalledWith(SRC, 3, { durability: 80, phoneId: 'a' });
  });

  it('refuses when the slot is not one the player actually holds', () => {
    const SetMetadata = vi.fn();
    useResources({
      ox_inventory: { GetSlotsWithItem: vi.fn(() => [{ slot: 3, metadata: {} }]), SetMetadata }
    });

    expect(writeItemMetadata(SRC, {}, ITEM, 9, { phoneId: 'a' })).toBe(false);
    expect(SetMetadata).not.toHaveBeenCalled();
  });

  it('uses qb-inventory SetItemData when it is exposed', () => {
    const SetItemData = vi.fn(() => true);
    useResources({ 'qb-inventory': { SetItemData } });

    expect(writeItemMetadata(SRC, {}, ITEM, 1, { phoneId: 'a' })).toBe(true);
    expect(SetItemData).toHaveBeenCalledWith(SRC, ITEM, 'phoneId', 'a');
  });

  it('reports a qb-inventory write that did not take, rather than claiming it stored', () => {
    useResources({ 'qb-inventory': { SetItemData: vi.fn(() => false) } });
    expect(writeItemMetadata(SRC, {}, ITEM, 1, { phoneId: 'a' })).toBe(false);
  });

  it('refuses and says so once when no inventory can write', () => {
    expect(writeItemMetadata(SRC, {}, ITEM, 1, { phoneId: 'a' })).toBe(false);
    expect(writeItemMetadata(SRC, {}, ITEM, 1, { phoneId: 'a' })).toBe(false);

    expect(console.warn).toHaveBeenCalledOnce();
  });
});
