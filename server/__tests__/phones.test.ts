// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, bridgeMock, handlers } = vi.hoisted(() => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_phone_item' ? 'phone' : fallback;
  // Every handler per event, not the last: `phoneItem.ts` and `Phones.ts` both listen for
  // `playerDropped`, and a Map that kept one would test whichever registered second.
  const captured = new Map<string, Function[]>();
  const capture = (event: string, handler: Function) => {
    captured.set(event, [...(captured.get(event) ?? []), handler]);
  };
  (globalThis as any).on = capture;
  (globalThis as any).onNet = capture;

  return {
    dbMock: {
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      scalar: vi.fn(),
      single: vi.fn()
    },
    bridgeMock: {
      getPlayer: vi.fn(),
      itemSlots: vi.fn(),
      setItemMetadata: vi.fn(() => true),
      registerUsableItem: vi.fn(),
      countItem: vi.fn(() => 1),
      // `lib/shell.ts` also listens for `playerDropped`, and this suite fires every listener.
      forgetSource: vi.fn(),
      rememberSource: vi.fn()
    },
    handlers: captured
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => 'qbx'
}));

import {
  activePhone,
  activePhoneIdOf,
  onPhoneHandover,
  phoneForCitizen,
  phoneForRequest,
  phones,
  resolvePhone,
  __resetPhoneState
} from '../services/Phones';
import { __resetLastUsedPhone, __resetPhoneItemWarnings } from '../lib/phoneItem';

/**
 * `phoneItem.ts` registers its usable-item callback at import time, and `clearAllMocks`
 * wipes the call that recorded it — so it is taken here, once, while it is still there.
 */
const usePhoneItem: (src: number, used?: { slot?: unknown }) => void =
  bridgeMock.registerUsableItem.mock.calls.find((call: unknown[]) => call[0] === 'phone')?.[1];

/**
 * The phone as its own identity (MICA-280).
 *
 * The case that matters most is the one a truthiness check would miss: an inventory that
 * cannot carry metadata answers `null` from MICA-279's seam, and minting on that would hand a
 * player a brand new phone on every single resolve.
 */

const SRC = 7;
const CID = 'ABC12345';
const ID_SHAPE = /^[0-9a-f]{32}$/;

const player = { citizenid: CID, source: SRC, setMeta: vi.fn(), rawPlayer: {} };

/** `mica_phone_item` is what gates the whole feature; empty means no per-item identity. */
const gateOn = (item = 'phone') => {
  globalThis.GetConvar = ((name: string, fallback: string) =>
    name === 'mica_phone_item' ? item : fallback) as any;
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetPhoneState();
  __resetLastUsedPhone();
  __resetPhoneItemWarnings();
  globalThis.emitNet = vi.fn() as any;
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  bridgeMock.getPlayer.mockReturnValue(player);
  bridgeMock.setItemMetadata.mockReturnValue(true);
  gateOn();
});

describe('the phones table declaration', () => {
  it('is server-authored, so no column is client-writable', () => {
    expect(phones.repo.writableColumns).toEqual([]);
  });

  it('keeps phone_id unique but lets one citizen hold several phones', () => {
    const unique = phones.resolved.indexes.filter((i) => i.unique).map((i) => i.name);
    expect(unique).toEqual(['phone_id_unique']);
  });
});

describe('resolving the active phone', () => {
  it('mints an id into the item the first time and records a row', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: {} }]);

    const active = await activePhone(SRC);

    expect(active?.slot).toBe(3);
    expect(active?.phoneId).toMatch(ID_SHAPE);
    expect(bridgeMock.setItemMetadata).toHaveBeenCalledWith(player, 'phone', 3, {
      phoneId: active?.phoneId
    });
    expect(dbMock.insert).toHaveBeenCalledOnce();
  });

  it('reuses the id already on the item rather than minting a second', async () => {
    const carried = 'a'.repeat(32);
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: carried } }]);

    expect((await activePhone(SRC))?.phoneId).toBe(carried);
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
  });

  it('prefers the slot the player last used over the lowest one', async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { phoneId: 'b'.repeat(32) } },
      { slot: 8, metadata: { phoneId: 'c'.repeat(32) } }
    ]);

    // Driven through the real callback, the way qbx_core calls it: `fun(source, item)`.
    expect(usePhoneItem, 'the phone item registers a usable-item callback').toBeTypeOf('function');
    usePhoneItem(SRC, { slot: 8 });

    expect((await activePhone(SRC))?.slot).toBe(8);
  });

  it('falls back to the lowest slot when nothing has been used this session', async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { phoneId: 'b'.repeat(32) } },
      { slot: 8, metadata: { phoneId: 'c'.repeat(32) } }
    ]);

    expect((await activePhone(SRC))?.slot).toBe(2);
  });

  it('forgets the last-used slot on a disconnect, so a reused id inherits nothing', async () => {
    bridgeMock.itemSlots.mockReturnValue([
      { slot: 2, metadata: { phoneId: 'b'.repeat(32) } },
      { slot: 8, metadata: { phoneId: 'c'.repeat(32) } }
    ]);
    usePhoneItem(SRC, { slot: 8 });

    (globalThis as any).source = SRC;
    for (const dropped of handlers.get('playerDropped')!) dropped();

    expect((await activePhone(SRC))?.slot).toBe(2);
  });
});

describe('refusing to mint when it would be wrong', () => {
  it('mints nothing when the inventory cannot carry metadata at all', async () => {
    // `null` from the seam, not an empty list. Minting here would issue a fresh phone on every
    // resolve for a server that can never store one.
    bridgeMock.itemSlots.mockReturnValue(null);

    expect(await activePhone(SRC)).toBeNull();
    expect(bridgeMock.setItemMetadata).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('mints nothing for a player holding no phone', async () => {
    bridgeMock.itemSlots.mockReturnValue([]);
    expect(await activePhone(SRC)).toBeNull();
  });

  it('refuses when the metadata write did not take, rather than claiming an id', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: {} }]);
    bridgeMock.setItemMetadata.mockReturnValue(false);

    expect(await activePhone(SRC)).toBeNull();
    // No row either: an id the item does not carry would be a different phone next relog.
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('answers null when no phone item is configured at all', async () => {
    gateOn('');
    expect(await activePhone(SRC)).toBeNull();
    expect(bridgeMock.itemSlots).not.toHaveBeenCalled();
  });

  it('answers null for a source with no loaded character', async () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    expect(await activePhone(SRC)).toBeNull();
  });

  it('re-mints an id the item carries in a shape nothing here would have written', async () => {
    // Item metadata is another resource's storage and a modified inventory can put anything
    // there. Shape-checked before it reaches SQL; MICA-281 adds the predicate that makes a
    // well-formed but stolen id useless.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: "'; DROP TABLE--" } }]);

    const active = await activePhone(SRC);

    expect(active?.phoneId).toMatch(ID_SHAPE);
  });
});

/**
 * MICA-282: the phone a request is for, and what happens when a phone changes hands.
 *
 * Driven through `phoneForRequest` directly rather than the seam in `lib/phoneIdentity.ts`,
 * because `setup.ts` puts a stub in that seam before every test; the real resolver is what
 * is under test here.
 */
describe('the phone a request is for', () => {
  const OTHER = 'ZZZ99999';

  it('is the phone in hand on a gated server', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: CID, phone_id: 'a'.repeat(32), claimed: 1 }
    ]);

    await expect(phoneForRequest(SRC, CID)).resolves.toBe('a'.repeat(32));
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('refuses a player holding no phone on a gated server, in words they can read', async () => {
    bridgeMock.itemSlots.mockReturnValue([]);

    await expect(phoneForRequest(SRC, CID)).rejects.toMatchObject({
      name: 'PlayerFacingError',
      key: 'server.phone.notHeld'
    });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('falls back to the identity phone where no phone id can be carried, minting it once', async () => {
    // `null` from the seam: this inventory cannot hold metadata. One phone per citizen, then.
    bridgeMock.itemSlots.mockReturnValue(null);
    dbMock.query.mockResolvedValue([]);

    const first = await phoneForRequest(SRC, CID);
    const second = await phoneForRequest(SRC, CID);

    expect(first).toMatch(ID_SHAPE);
    expect(second).toBe(first);
    // Minted unclaimed — never written into an item — and only the once.
    expect(dbMock.insert).toHaveBeenCalledOnce();
    expect(dbMock.insert.mock.calls[0][1]).toEqual([CID, first, 0]);
  });

  it('reuses an unclaimed phone the migration minted rather than minting a second', async () => {
    bridgeMock.itemSlots.mockReturnValue(null);
    dbMock.query.mockResolvedValue([
      { id: 9, citizenid: CID, phone_id: 'e'.repeat(32), claimed: 0 }
    ]);

    await expect(phoneForRequest(SRC, CID)).resolves.toBe('e'.repeat(32));
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('adopts the unclaimed phone into the first item with no id, and claims it', async () => {
    // The upgrade path: the migration's backfill is on the unclaimed phone, so the item in
    // hand takes that id instead of a fresh one, and the rows land where the player expects.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: {} }]);
    dbMock.query.mockResolvedValue([
      { id: 9, citizenid: CID, phone_id: 'e'.repeat(32), claimed: 0 }
    ]);

    await expect(phoneForRequest(SRC, CID)).resolves.toBe('e'.repeat(32));

    expect(bridgeMock.setItemMetadata).toHaveBeenCalledWith(player, 'phone', 3, {
      phoneId: 'e'.repeat(32)
    });
    expect(dbMock.insert).not.toHaveBeenCalled();
    const claim = dbMock.update.mock.calls.find(([sql]) => String(sql).includes('`claimed` = ?'));
    expect(claim, 'the phone is marked claimed').toBeDefined();
    expect(claim![1]).toEqual([1, 9, CID]);
  });

  it('hands a phone over to whoever is holding it, moving every phone-keyed table', async () => {
    // Steal a phone: the row names the previous holder, the item is in this player's hand.
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: OTHER, phone_id: 'a'.repeat(32), claimed: 1 }
    ]);
    const hook = vi.fn();
    onPhoneHandover('test-hook', hook);

    await expect(phoneForRequest(SRC, CID)).resolves.toBe('a'.repeat(32));

    const transfers = dbMock.update.mock.calls
      .map(([sql, params]) => ({ sql: String(sql).replace(/\s+/g, ' '), params }))
      .filter((c) => c.sql.includes('WHERE `phone_id` = ? AND `citizenid` <> ?'));
    // Every repository that carries a phone_id — this suite declares `phones` alone — and
    // the same three parameters for each: the new holder, the phone, and the new holder again.
    expect(transfers.length).toBeGreaterThan(0);
    for (const t of transfers) {
      expect(t.sql).toMatch(/^UPDATE `mica_\w+` SET `citizenid` = \?/);
      expect(t.params).toEqual([CID, 'a'.repeat(32), CID]);
    }
    expect(hook).toHaveBeenCalledWith('a'.repeat(32), CID);
  });

  it('does not hand over a phone whose holder is unchanged, and asks nothing twice', async () => {
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: CID, phone_id: 'a'.repeat(32), claimed: 1 }
    ]);

    await phoneForRequest(SRC, CID);
    await phoneForRequest(SRC, CID);

    expect(dbMock.update).not.toHaveBeenCalled();
    // The holder is cached after the first resolve.
    expect(dbMock.query).toHaveBeenCalledOnce();
  });

  it("resolves a citizen's phone for a row written on their behalf", async () => {
    // Nothing resolved this process, no row in `mica_phones`: an identity phone is minted.
    dbMock.single.mockResolvedValue(null);
    dbMock.query.mockResolvedValue([]);

    const minted = await phoneForCitizen(CID);
    expect(minted).toMatch(ID_SHAPE);

    // With a phone on record, the most recently touched one wins and nothing is minted.
    dbMock.insert.mockClear();
    __resetPhoneState();
    dbMock.single.mockResolvedValue({ phone_id: 'f'.repeat(32) });
    await expect(phoneForCitizen(CID)).resolves.toBe('f'.repeat(32));
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('the phone a source is on, synchronously', () => {
  it('is unknown before the first resolve, known after it, and forgotten on a disconnect', async () => {
    expect(activePhoneIdOf(SRC)).toBeNull();

    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: 'a'.repeat(32) } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: CID, phone_id: 'a'.repeat(32), claimed: 1 }
    ]);
    await resolvePhone(SRC);
    expect(activePhoneIdOf(SRC)).toBe('a'.repeat(32));

    (globalThis as any).source = SRC;
    for (const dropped of handlers.get('playerDropped')!) dropped();
    expect(activePhoneIdOf(SRC)).toBeNull();
  });

  it('is the identity phone where no item can carry one', async () => {
    bridgeMock.itemSlots.mockReturnValue(null);
    dbMock.query.mockResolvedValue([]);

    const identity = await phoneForRequest(SRC, CID);
    expect(activePhoneIdOf(SRC)).toBe(identity);
  });
});
