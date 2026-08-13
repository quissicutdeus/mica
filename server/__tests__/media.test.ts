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

const bridge = vi.hoisted(() => ({ citizenid: 'CID_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.citizenid, source: 5, setMeta: () => {} }),
    getSourceByCitizenId: () => 5,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {}
  }
}));

const proximity = vi.hoisted(() => ({ nearby: [] as { source: number; citizenid: string }[] }));
vi.mock('../lib/proximity', () => ({
  findNearbyVisiblePlayers: vi.fn(async () => proximity.nearby)
}));

import '../services/Media';

const DROP_EVENT = 'gphone:server:media:drop';
const SHARE_LOCATION_EVENT = 'gphone:server:media:shareLocation';

const call = async (event: string, data: unknown) => {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

const callDrop = (data: unknown) => call(DROP_EVENT, data);
const callShareLocation = (data: unknown) => call(SHARE_LOCATION_EVENT, data);

/**
 * `playerCoords` guards on these natives existing at all, so a test environment with none
 * of them defined always resolves `null` — exactly the "could not determine your location"
 * path. Setting them here is what lets the happy-path tests reach past that guard.
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

const OWNED_ROW = {
  id: 42,
  citizenid: 'CID_A',
  kind: 'photo',
  data: 'base64-bytes',
  url: null,
  thumbnail: null,
  mime_type: null,
  width: null,
  height: null,
  duration_ms: null,
  byte_size: null,
  alt_text: null,
  status: 'active'
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.single.mockReset();
  dbMock.insert.mockReset();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(99);
  bridge.citizenid = 'CID_A';
  proximity.nearby = [];
  natives.coords = [100, 200, 30];
  clearPlayerPed();
});

describe('media:drop', () => {
  it('rejects a mediaId that is not a positive integer', async () => {
    const reply = await callDrop({ mediaId: -1 });
    expect(reply.error).toMatch(/valid mediaId/);
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('refuses a mediaId the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await callDrop({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a moderated photo, even though the owner can still find it by id', async () => {
    // findById scopes by citizenid but not by status, so a row a moderator pulled from
    // every ordinary read is still reachable by id — this is the one place that has to
    // check status itself rather than trusting the ownership predicate alone.
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, status: 'moderated' });

    const reply = await callDrop({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a photo the owner has already deleted', async () => {
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, status: 'deleted' });

    const reply = await callDrop({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('copies the row to each nearby, visible player and reports the count', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];

    const reply = await callDrop({ mediaId: 42 });

    expect(reply).toEqual({ count: 2 });
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
    for (const [, params] of dbMock.insert.mock.calls) {
      expect(params as unknown[]).not.toContain('CID_A');
    }
  });

  it('notifies each recipient', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await callDrop({ mediaId: 42 });

    const push = (globalThis.emitNet as any).mock.calls.find(
      (args: unknown[]) => args[0] === 'gphone:client:shell:appEvent'
    );
    expect(push?.[2]).toMatchObject({ app: 'media', event: 'media_received' });
  });

  it('reports zero and writes nothing when nobody is nearby', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [];

    const reply = await callDrop({ mediaId: 42 });

    expect(reply).toEqual({ count: 0 });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('media:shareLocation', () => {
  it('refuses when the player position cannot be determined', async () => {
    // No GetPlayerPed/DoesEntityExist/GetEntityCoords defined — playerCoords resolves null.
    const reply = await callShareLocation({ label: 'Vinewood Blvd' });

    expect(reply.error).toMatch(/location/i);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('writes the row using the server-read position, never anything from the payload', async () => {
    setPlayerPed();
    natives.coords = [111, 222, 33];
    dbMock.insert.mockResolvedValueOnce(55);
    dbMock.single.mockResolvedValueOnce({
      ...OWNED_ROW,
      id: 55,
      kind: 'location',
      data: JSON.stringify({ x: 111, y: 222, z: 33 }),
      alt_text: 'Vinewood Blvd'
    });

    // A payload smuggling its own x/y/z must be ignored — only `label` is ever read.
    const reply = await callShareLocation({
      label: 'Vinewood Blvd',
      x: 999,
      y: 999,
      z: 999
    });

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    const [, params] = dbMock.insert.mock.calls[0];
    expect(params as unknown[]).not.toContain(999);
    expect(JSON.stringify(params)).toContain('111');
    expect(JSON.stringify(params)).toContain('222');
    expect(JSON.stringify(params)).toContain('33');

    expect(reply).toEqual({
      id: 55,
      media: expect.objectContaining({ id: 55, kind: 'location' })
    });
  });

  it('truncates an over-long label to the alt_text column length', async () => {
    setPlayerPed();
    dbMock.insert.mockResolvedValueOnce(56);
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, id: 56, kind: 'location' });

    const longLabel = 'x'.repeat(400);
    await callShareLocation({ label: longLabel });

    const [, params] = dbMock.insert.mock.calls[0];
    const writtenLabel = (params as unknown[]).find(
      (v) => typeof v === 'string' && v.startsWith('xxx')
    );
    expect((writtenLabel as string).length).toBe(255);
  });

  it('drops a non-string or empty label rather than writing it as-is', async () => {
    setPlayerPed();
    dbMock.insert.mockResolvedValueOnce(57);
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, id: 57, kind: 'location' });

    await callShareLocation({ label: '   ' });

    const [, params] = dbMock.insert.mock.calls[0];
    expect(params as unknown[]).not.toContain('   ');
  });
});
