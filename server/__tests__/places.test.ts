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

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, setMeta: () => {} })
  }
}));

import { places } from '../services/Places';
import { __resetRateLimits } from '../lib/rateLimit';

const call = async (action: string, data: unknown) => {
  const handler = handlers.get(`gphone:server:places:${action}`);
  if (!handler) throw new Error(`no handler for places:${action}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

/**
 * `playerCoords` guards on these natives existing at all — the same fixture
 * `media.test.ts` uses for `shareLocation`, since `create` here resolves position the
 * same way.
 */
const natives = vi.hoisted(() => ({ coords: [100, 200, 30] as [number, number, number] | null }));
const setPlayerPed = () => {
  (globalThis as any).GetPlayerPed = () => 77;
  (globalThis as any).DoesEntityExist = () => true;
  (globalThis as any).GetEntityCoords = () => natives.coords;
};
const clearPlayerPed = () => {
  delete (globalThis as any).GetPlayerPed;
  delete (globalThis as any).DoesEntityExist;
  delete (globalThis as any).GetEntityCoords;
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(101);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  natives.coords = [100, 200, 30];
  setPlayerPed();
});

describe('places:create (MICA-65)', () => {
  it('saves the caller position under the given name', async () => {
    dbMock.single.mockResolvedValue({
      id: 101,
      citizenid: 'CIT_A',
      name: 'Home',
      x: 100,
      y: 200,
      z: 30
    });

    const reply = await call('create', { name: 'Home' });

    expect(reply).toMatchObject({ id: 101, place: expect.objectContaining({ name: 'Home' }) });
    const [sql, params] = dbMock.insert.mock.calls[0];
    expect(String(sql)).toBe(
      'INSERT INTO `gphone_places` (`name`, `x`, `y`, `z`, `citizenid`) VALUES (?, ?, ?, ?, ?)'
    );
    expect(params).toEqual(['Home', 100, 200, 30, 'CIT_A']);
  });

  it('carries street_label when the caller sends one', async () => {
    await call('create', { name: 'Home', street_label: 'Vinewood Blvd' });

    const [, params] = dbMock.insert.mock.calls[0];
    expect(params).toContain('Vinewood Blvd');
  });

  it('refuses an empty or missing name, without touching the database', async () => {
    let reply = await call('create', {});
    expect(reply).toMatchObject({ error: expect.stringMatching(/name is required/i) });

    reply = await call('create', { name: '   ' });
    expect(reply).toMatchObject({ error: expect.stringMatching(/name is required/i) });

    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses when the server cannot resolve the caller position', async () => {
    clearPlayerPed();

    const reply = await call('create', { name: 'Home' });

    expect(reply).toMatchObject({ error: expect.stringMatching(/could not determine/i) });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('caps an oversized name and street_label rather than rejecting outright', async () => {
    await call('create', { name: 'H'.repeat(500), street_label: 'S'.repeat(500) });

    const [, params] = dbMock.insert.mock.calls[0] as [string, string[]];
    expect(params[0].length).toBe(100);
    expect(params.find((p) => typeof p === 'string' && p.startsWith('S'))?.length).toBe(255);
  });

  it('ignores any x/y/z the payload sends — position always comes from the server', async () => {
    await call('create', { name: 'Home', x: 0, y: 0, z: 0 });

    const [, params] = dbMock.insert.mock.calls[0];
    // The resolved native position, not the payload's zeros.
    expect(params).toEqual(expect.arrayContaining([100, 200, 30]));
    expect(params).not.toEqual(expect.arrayContaining([0]));
  });

  it('writes under the caller citizenid, never one the payload names', async () => {
    await call('create', { name: 'Home', citizenid: 'CIT_VICTIM' });

    const [, params] = dbMock.insert.mock.calls[0];
    expect(params.at(-1)).toBe('CIT_A');
  });
});

describe('places — the declaration', () => {
  it('disables the generic create in favour of the custom one', () => {
    expect(handlers.has('gphone:server:places:create')).toBe(true);
    expect(places.resolved.columns).toContain('x');
  });

  it('keeps x/y/z out of the client-writable set, so the generic update cannot move a place', () => {
    for (const column of ['x', 'y', 'z']) {
      expect(places.repo['clientWritable']).not.toContain(column);
    }
    expect(places.repo['clientWritable']).toEqual(expect.arrayContaining(['name', 'street_label']));
  });

  it('registers the generic get/update/delete, owner-scoped like every other saved row', () => {
    expect(handlers.has('gphone:server:places:get')).toBe(true);
    expect(handlers.has('gphone:server:places:update')).toBe(true);
    expect(handlers.has('gphone:server:places:delete')).toBe(true);
  });
});

describe('places:update / places:delete — ownership, not just an id', () => {
  it('scopes update to the caller citizenid', async () => {
    await call('update', { id: 7, name: 'Renamed' });

    expect(dbMock.update.mock.calls[0][1]).toEqual(['Renamed', 7, 'CIT_A']);
  });

  it('scopes delete to the caller citizenid', async () => {
    await call('delete', { id: 7 });

    expect(dbMock.update.mock.calls[0][1]).toEqual(['deleted', 7, 'CIT_A']);
  });

  it('scopes get to the caller citizenid', async () => {
    await call('get', {});

    expect(dbMock.query.mock.calls[0][1]).toEqual(['CIT_A', 'active']);
  });
});
