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

import '../services/Photos';

const DROP_EVENT = 'gphone:server:photos:drop';

const call = async (data: unknown) => {
  const handler = handlers.get(DROP_EVENT);
  if (!handler) throw new Error(`no handler for ${DROP_EVENT}`);
  (globalThis as any).source = 5;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
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
});

describe('photos:drop', () => {
  it('rejects a mediaId that is not a positive integer', async () => {
    const reply = await call({ mediaId: -1 });
    expect(reply.error).toMatch(/valid mediaId/);
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('refuses a mediaId the caller does not own', async () => {
    dbMock.single.mockResolvedValueOnce(null);

    const reply = await call({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a moderated photo, even though the owner can still find it by id', async () => {
    // findById scopes by citizenid but not by status, so a row a moderator pulled from
    // every ordinary read is still reachable by id — this is the one place that has to
    // check status itself rather than trusting the ownership predicate alone.
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, status: 'moderated' });

    const reply = await call({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('refuses a photo the owner has already deleted', async () => {
    dbMock.single.mockResolvedValueOnce({ ...OWNED_ROW, status: 'deleted' });

    const reply = await call({ mediaId: 42 });

    expect(reply.error).toMatch(/could not be found/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('copies the row to each nearby, visible player and reports the count', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];

    const reply = await call({ mediaId: 42 });

    expect(reply).toEqual({ count: 2 });
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
    for (const [, params] of dbMock.insert.mock.calls) {
      expect(params as unknown[]).not.toContain('CID_A');
    }
  });

  it('notifies each recipient', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await call({ mediaId: 42 });

    const push = (globalThis.emitNet as any).mock.calls.find(
      (args: unknown[]) => args[0] === 'gphone:client:shell:appEvent'
    );
    expect(push?.[2]).toMatchObject({ app: 'photos', event: 'media_received' });
  });

  it('reports zero and writes nothing when nobody is nearby', async () => {
    dbMock.single.mockResolvedValueOnce(OWNED_ROW);
    proximity.nearby = [];

    const reply = await call({ mediaId: 42 });

    expect(reply).toEqual({ count: 0 });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});
