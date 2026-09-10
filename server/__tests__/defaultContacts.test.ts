// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { dbMock, bridgeMock, convar } = vi.hoisted(() => {
  const convar: Record<string, string> = {};
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name in convar ? convar[name] : fallback;
  return {
    convar,
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    bridgeMock: {
      getPlayer: vi.fn(),
      itemSlots: vi.fn(),
      setItemMetadata: vi.fn(() => true),
      registerUsableItem: vi.fn(),
      countItem: vi.fn(() => 1),
      forgetSource: vi.fn(),
      rememberSource: vi.fn(),
      getSourceByCitizenId: vi.fn(() => undefined),
      getSourcesByCitizenId: vi.fn(() => new Map())
    }
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => 'qbx'
}));

import { __resetPhoneState, identityPhone, resolvePhone } from '../services/Phones';
// Registers the seeding hook, which is the thing under test.
import '../services/Contacts';
import { __resetOwnerConfig } from '../lib/ownerConfig';

/**
 * A new phone starts with the owner's default contacts, once (MICA-234).
 *
 * Driven through the real `Phones.ts` and `Contacts.ts` with only the database mocked, so what
 * is proved is the wiring as well as the rule: that each place a phone row is first inserted
 * seeds it, that nothing else does, and that a seed failing never fails the phone.
 */

const SRC = 7;
const CID = 'ABC12345';
const CARRIED = 'a'.repeat(32);
const ID_SHAPE = /^[0-9a-f]{32}$/;
const INLINE = JSON.stringify([
  { name: 'Dispatch', number: '911' },
  { name: 'Mechanic', number: '555-0100' }
]);

/** Each INSERT into a table, as a column-to-value record. */
const insertsInto = (table: string): Record<string, unknown>[] =>
  dbMock.insert.mock.calls
    .filter(([query]) => String(query).includes(`INTO \`${table}\``))
    .map(([query, values]) => {
      const columns = /\(([^)]*)\) VALUES/
        .exec(String(query))![1]
        .split(',')
        .map((column) => column.trim().replace(/`/g, ''));
      return Object.fromEntries(columns.map((column, i) => [column, (values as unknown[])[i]]));
    });

beforeEach(() => {
  vi.clearAllMocks();
  __resetPhoneState();
  __resetOwnerConfig();
  for (const key of Object.keys(convar)) delete convar[key];
  convar.mica_default_contacts = INLINE;
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  bridgeMock.getPlayer.mockReturnValue({ citizenid: CID, source: SRC, setMeta: vi.fn() });
  bridgeMock.setItemMetadata.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).LoadResourceFile;
});

describe('seeding a new phone', () => {
  it("seeds a citizen's newly minted identity phone, onto that phone", async () => {
    const phoneId = await identityPhone(CID);

    expect(phoneId).toMatch(ID_SHAPE);
    expect(insertsInto('mica_phones')).toHaveLength(1);
    expect(insertsInto('mica_contacts')).toEqual([
      { firstname: 'Dispatch', phone: '911', citizenid: CID, phone_id: phoneId },
      { firstname: 'Mechanic', phone: '555-0100', citizenid: CID, phone_id: phoneId }
    ]);
  });

  it("seeds a phone first recorded from the id on an item, onto that item's phone", async () => {
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: CARRIED } }]);

    const resolution = await resolvePhone(SRC);

    expect(resolution.status).toBe('active');
    expect(insertsInto('mica_contacts').map((row) => row.phone_id)).toEqual([CARRIED, CARRIED]);
  });

  it('seeds nothing when the owner set no contacts', async () => {
    delete convar.mica_default_contacts;

    await identityPhone(CID);

    expect(insertsInto('mica_phones')).toHaveLength(1);
    expect(insertsInto('mica_contacts')).toEqual([]);
  });

  it('seeds from a file inside this resource', async () => {
    const load = vi.fn(() => '[{"name":"Taxi","number":"555-0199"}]');
    (globalThis as any).LoadResourceFile = load;
    convar.mica_default_contacts = 'data/contacts.json';

    await identityPhone(CID);

    expect(load).toHaveBeenCalledWith('mica', 'data/contacts.json');
    expect(insertsInto('mica_contacts')).toMatchObject([{ firstname: 'Taxi', phone: '555-0199' }]);
  });
});

describe('never seeding twice', () => {
  it('does not seed a phone that already has a row: a claim, a handover', async () => {
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: CARRIED } }]);
    dbMock.query.mockResolvedValue([
      { id: 1, citizenid: 'SOMEONE_ELSE', phone_id: CARRIED, claimed: 0 }
    ]);

    await resolvePhone(SRC);

    expect(insertsInto('mica_contacts')).toEqual([]);
  });

  it('does not re-seed after the player deletes a seeded contact and the server restarts', async () => {
    const phoneId = await identityPhone(CID);
    expect(insertsInto('mica_contacts')).toHaveLength(2);

    // The contacts table is whatever the player made of it; the phone row is what persists.
    __resetPhoneState();
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, phone_id: phoneId, claimed: 0 }]);

    expect(await identityPhone(CID)).toBe(phoneId);
    expect(insertsInto('mica_contacts')).toHaveLength(2);
  });

  it('does not seed again on a second resolve of the same new phone', async () => {
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: CARRIED } }]);

    await resolvePhone(SRC);
    await resolvePhone(SRC);

    expect(insertsInto('mica_contacts')).toHaveLength(2);
  });
});

describe('seeding never fails the phone', () => {
  it('creates the identity phone when every contact insert fails, and logs why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.insert.mockImplementation(async (query: string) => {
      if (query.includes('`mica_contacts`')) throw new Error('database went away');
      return 1;
    });

    await expect(identityPhone(CID)).resolves.toMatch(ID_SHAPE);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("new-phone hook 'defaultContacts' failed"),
      expect.any(Error)
    );
  });

  it('resolves the phone in hand when seeding fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    convar.mica_phone_item = 'phone';
    bridgeMock.itemSlots.mockReturnValue([{ slot: 3, metadata: { phoneId: CARRIED } }]);
    dbMock.insert.mockImplementation(async (query: string) => {
      if (query.includes('`mica_contacts`')) throw new Error('database went away');
      return 1;
    });

    const resolution = await resolvePhone(SRC);

    expect(resolution).toMatchObject({ status: 'active', phone: { phoneId: CARRIED } });
  });

  it('creates the phone when the contacts file is missing, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).LoadResourceFile = () => null;
    convar.mica_default_contacts = 'data/missing.json';

    await expect(identityPhone(CID)).resolves.toMatch(ID_SHAPE);
    expect(insertsInto('mica_contacts')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mica_default_contacts'));
  });
});
