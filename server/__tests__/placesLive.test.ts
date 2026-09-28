// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

/**
 * Three players: A (source 5) shares, B (source 6) is A's contact, C (source 7) is not.
 * `online` is who the bridge says is connected, so a sharer can be made to leave.
 */
const world = vi.hoisted(() => ({
  players: {
    5: { citizenid: 'CIT_A', phone: '555-0001' },
    6: { citizenid: 'CIT_B', phone: '555-0002' },
    7: { citizenid: 'CIT_C', phone: '555-0003' }
  } as Record<number, { citizenid: string; phone: string }>,
  online: new Set([5, 6, 7]),
  /** A source the bridge's reverse index still names for a citizen it no longer carries. */
  stale: {} as Record<string, number>,
  coords: {
    5: [100, 200, 30],
    6: [-50, -60, 10],
    7: [900, 900, 5]
  } as Record<number, [number, number, number]>
}));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) =>
      world.online.has(src)
        ? { citizenid: world.players[src].citizenid, source: src, setMeta: () => {} }
        : undefined,
    getPlayerPhone: (src: number) => world.players[src]?.phone ?? null,
    getSourceByCitizenId: (cid: string) => {
      if (world.stale[cid] !== undefined) return world.stale[cid];
      for (const [src, p] of Object.entries(world.players)) {
        if (p.citizenid === cid && world.online.has(Number(src))) return Number(src);
      }
      return null;
    },
    getAllPlayers: () => ({}),
    getPlayerByPhone: (phone: string) => {
      for (const [src, p] of Object.entries(world.players)) {
        if (p.phone === phone && world.online.has(Number(src))) return { citizenid: p.citizenid };
      }
      return undefined;
    }
  }
}));

vi.mock('../lib/PlayerDirectory', () => ({
  resolveByPhone: async (phone: string) => {
    const hit = Object.values(world.players).find((p) => p.phone === phone);
    return hit ? { citizenid: hit.citizenid, displayName: null, phone } : null;
  },
  resolve: async () => null,
  resolveMany: async () => new Map()
}));

import {
  __resetLiveShares,
  __setLiveClock,
  parseMapBounds,
  parseMapImage,
  snapDuration,
  tickLiveShares,
  DEFAULT_MAP_BOUNDS
} from '../services/PlacesLive';
import { __resetRateLimits } from '../lib/rateLimit';
import { TEST_PHONE_ID } from './phoneStub';

/** A's address book: 1 is B, 2 is C but deleted, 3 is A's own number. */
const contactRows: Record<number, { id: number; phone: string; status: string }> = {
  1: { id: 1, phone: '555-0002', status: 'active' },
  2: { id: 2, phone: '555-0003', status: 'deleted' },
  3: { id: 3, phone: '555-0001', status: 'active' }
};

const call = async (src: number, action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:places:${action}`);
  if (!handler) throw new Error(`no handler for places:${action}`);
  (globalThis as any).source = src;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

let clock = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetLiveShares();
  clock = 1_000_000;
  __setLiveClock(() => clock);
  world.online = new Set([5, 6, 7]);
  world.stale = {};
  world.players[5] = { citizenid: 'CIT_A', phone: '555-0001' };
  world.players[6] = { citizenid: 'CIT_B', phone: '555-0002' };
  world.players[7] = { citizenid: 'CIT_C', phone: '555-0003' };
  dbMock.query.mockResolvedValue([]);
  dbMock.single.mockImplementation(async (sql: string, params: unknown[]) =>
    String(sql).includes('`mica_contacts`') && params[1] === 'CIT_A'
      ? (contactRows[Number(params[0])] ?? null)
      : null
  );
  (globalThis as any).GetPlayerPed = (src: string) => Number(src);
  (globalThis as any).DoesEntityExist = () => true;
  (globalThis as any).GetEntityCoords = (ped: number) => world.coords[ped];
});

describe('places:startSharing (MICA-244)', () => {
  it('reaches only the sharer’s own active contacts, read under their ownership predicate', async () => {
    const reply = await call(5, 'startSharing', { contact_ids: [1, 2, 3, 99], minutes: 15 });

    // 1 is B; 2 is deleted; 3 is the sharer's own number; 99 is not A's row.
    expect(reply).toMatchObject({ recipients: 1, expires_at: clock + 15 * 60_000 });
    for (const [sql, params] of dbMock.single.mock.calls) {
      expect(String(sql)).toContain('`citizenid` = ?');
      expect(params).toContain('CIT_A');
      expect(params).toContain(TEST_PHONE_ID);
    }
  });

  it('refuses a payload that names a position, and an oversized recipient list', async () => {
    let reply = await call(5, 'startSharing', { contact_ids: [1], minutes: 15, x: 1, y: 2 });
    expect(reply).toMatchObject({ error: expect.any(String) });
    reply = await call(5, 'startSharing', {
      contact_ids: Array.from({ length: 11 }, (_, i) => i + 1),
      minutes: 15
    });
    expect(reply).toMatchObject({ error: expect.stringMatching(/more than 10/) });
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('drops a recipient who has blocked the sharer, and refuses when nobody is left', async () => {
    dbMock.query.mockImplementation(async (sql: string) =>
      String(sql).includes('mica_blocklist') ? [{ citizenid: 'CIT_B' }] : []
    );
    const reply = await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    expect(reply).toMatchObject({ error: expect.stringMatching(/none of those contacts/i) });
    expect((await call(6, 'live', {})).incoming).toEqual([]);
  });

  it('snaps the duration to an allowed one', () => {
    expect(snapDuration(1)).toBe(15);
    expect(snapDuration(16)).toBe(60);
    expect(snapDuration(240)).toBe(240);
  });
});

describe('places:live (MICA-244)', () => {
  it('gives a recipient the server’s own view of the sharer, and a stranger nothing', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 60 });

    const forB = await call(6, 'live', {});
    expect(forB.self).toEqual({ x: -50, y: -60 });
    expect(forB.incoming).toEqual([
      {
        id: expect.any(Number),
        number: '555-0001',
        x: 100,
        y: 200,
        updated_at: clock,
        expires_at: clock + 3_600_000
      }
    ]);
    expect((await call(7, 'live', {})).incoming).toEqual([]);

    const forA = await call(5, 'live', {});
    expect(forA.outgoing).toEqual({ recipients: 1, expires_at: clock + 3_600_000 });
  });

  it('takes no payload at all', async () => {
    const reply = await call(6, 'live', { x: 1, y: 1 });
    expect(reply).toMatchObject({ error: expect.any(String) });
  });

  it('follows the sharer as the server samples them', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    world.coords[5] = [400, 500, 30];
    clock += 5_000;
    tickLiveShares();
    const [share] = (await call(6, 'live', {})).incoming;
    expect(share).toMatchObject({ x: 400, y: 500, updated_at: clock });
    world.coords[5] = [100, 200, 30];
  });
});

describe('ending a share (MICA-244)', () => {
  it('stops on request', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    expect(await call(5, 'stopSharing', {})).toEqual({ ok: true });
    expect((await call(6, 'live', {})).incoming).toEqual([]);
    expect((await call(5, 'live', {})).outgoing).toBeNull();
  });

  it('expires', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    clock += 15 * 60_000;
    expect((await call(6, 'live', {})).incoming).toEqual([]);
    tickLiveShares();
    expect((await call(5, 'live', {})).outgoing).toBeNull();
  });

  it('ends when the sharer is no longer online', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    world.online.delete(5);
    tickLiveShares();
    world.online.add(5);
    expect((await call(6, 'live', {})).incoming).toEqual([]);
  });
});

describe('the tick re-checks who is who (MICA-244 review)', () => {
  it('ends the share when the sharer’s source now carries another character', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    // Mid-switch: the reverse index still says CIT_A is on source 5, but source 5 is CIT_A2.
    world.players[5] = { citizenid: 'CIT_A2', phone: '555-0009' };
    world.stale.CIT_A = 5;
    world.coords[5] = [7777, 7777, 0];
    tickLiveShares();
    expect((await call(6, 'live', {})).incoming).toEqual([]);
    world.coords[5] = [100, 200, 30];
  });

  it('drops a recipient whose number now resolves to someone else', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    // B's number is now C's; B has a new one.
    world.players[6] = { citizenid: 'CIT_B', phone: '555-0100' };
    world.players[7] = { citizenid: 'CIT_C', phone: '555-0002' };
    tickLiveShares();
    expect((await call(6, 'live', {})).incoming).toEqual([]);
    expect((await call(7, 'live', {})).incoming).toEqual([]);
    // Nobody left to reach, so the share itself ended.
    expect((await call(5, 'live', {})).outgoing).toBeNull();
  });

  it('keeps an offline recipient, who is checked again once back', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    world.online.delete(6);
    tickLiveShares();
    world.online.add(6);
    expect((await call(6, 'live', {})).incoming).toHaveLength(1);
  });

  it('keys each share uniquely', async () => {
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    const first = (await call(6, 'live', {})).incoming[0].id;
    await call(5, 'startSharing', { contact_ids: [1], minutes: 15 });
    expect((await call(6, 'live', {})).incoming[0].id).not.toBe(first);
  });
});

describe('the sharer’s own phone is told (MICA-244 status-bar indicator)', () => {
  const pushes = () =>
    ((globalThis as any).emitNet as any).mock.calls.filter(
      (c: unknown[]) => c[0] === 'mica:client:shell:appEvent'
    );

  it('pushes places:live_share on start and on stop, to the sharer only', async () => {
    (globalThis as any).source = 5;
    const emit = vi.fn();
    const handler = handlers.get('mica:server:places:startSharing')!;
    (globalThis as any).emitNet = emit;
    await handler('cb-1', { contact_ids: [1], minutes: 15 });
    const started = emit.mock.calls.filter((c) => c[0] === 'mica:client:shell:appEvent');
    expect(started).toHaveLength(1);
    expect(started[0][1]).toBe(5);
    expect(started[0][2]).toMatchObject({
      app: 'places',
      event: 'live_share',
      payload: { active: true, expires_at: clock + 15 * 60_000 }
    });

    await call(5, 'stopSharing', {});
    expect(pushes()[0][2]).toMatchObject({ event: 'live_share', payload: { active: false } });
  });
});

describe('map configuration (MICA-244)', () => {
  it('accepts an https URL or a branding/ path, and nothing else', () => {
    expect(parseMapImage('https://cdn.example.com/map.png', 'mica')).toBe(
      'https://cdn.example.com/map.png'
    );
    expect(parseMapImage('branding/map.webp', 'mica')).toBe(
      'https://cfx-nui-mica/branding/map.webp'
    );
    expect(parseMapImage('', 'mica')).toBeNull();
    expect(parseMapImage('http://example.com/map.png', 'mica')).toBeNull();
    expect(parseMapImage('https://example.com/a"onload=x', 'mica')).toBeNull();
    expect(parseMapImage('branding/../server.cfg', 'mica')).toBeNull();
    expect(parseMapImage('javascript:alert(1)', 'mica')).toBeNull();
  });

  it('reads bounds as minX,minY,maxX,maxY and refuses an inverted or partial box', () => {
    expect(parseMapBounds('-4000, -4000, 4000, 8000')).toEqual({
      minX: -4000,
      minY: -4000,
      maxX: 4000,
      maxY: 8000
    });
    expect(parseMapBounds('1,2,3')).toBeNull();
    expect(parseMapBounds('10,0,0,10')).toBeNull();
    expect(parseMapBounds('a,b,c,d')).toBeNull();
  });

  it('answers the default atlas and interval when nothing is set', async () => {
    const reply = await call(6, 'mapConfig', {});
    expect(reply).toEqual({
      image: null,
      bounds: DEFAULT_MAP_BOUNDS,
      intervalSeconds: 5,
      durations: [15, 60, 240]
    });
  });

  it('clamps the interval', async () => {
    const original = (globalThis as any).GetConvarInt;
    (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
      name === 'mica_location_interval' ? 0 : fallback;
    expect((await call(6, 'mapConfig', {})).intervalSeconds).toBe(2);
    (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
      name === 'mica_location_interval' ? 9999 : fallback;
    expect((await call(6, 'mapConfig', {})).intervalSeconds).toBe(60);
    (globalThis as any).GetConvarInt = original;
  });
});
