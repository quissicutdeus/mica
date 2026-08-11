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

const bridge = vi.hoisted(() => ({ loaded: true, citizenid: 'CID_A', source: 5 }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () =>
      bridge.loaded
        ? { citizenid: bridge.citizenid, source: bridge.source, setMeta: () => {} }
        : null,
    getSourceByCitizenId: () => bridge.source,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {}
  }
}));

const proximity = vi.hoisted(() => ({ nearby: [] as { source: number; citizenid: string }[] }));
vi.mock('../lib/proximity', () => ({
  findNearbyVisiblePlayers: vi.fn(async () => proximity.nearby)
}));

import '../services/Contacts';
import { __resetRateLimits } from '../lib/rateLimit';

const SHARE_EVENT = 'gphone:server:contacts:share';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  dbMock.query.mockResolvedValue([]);
  bridge.loaded = true;
  bridge.citizenid = 'CID_A';
  bridge.source = 5;
  proximity.nearby = [];
  (globalThis as any).emitNet = vi.fn();
  (globalThis as any).source = 5;
});

/** Fire-and-forget: the handler carries no callback id and nothing awaits its reply. */
const call = async (data: unknown) => {
  const handler = handlers.get(SHARE_EVENT);
  if (!handler) throw new Error(`no handler for ${SHARE_EVENT}`);
  handler(data);
  // The handler's own body is async; let its microtasks settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const pushesTo = (event: string) =>
  (globalThis.emitNet as any).mock.calls.filter((args: unknown[]) => args[0] === event);

describe('contacts:share', () => {
  it('does nothing for a source with no loaded character', async () => {
    bridge.loaded = false;

    await call({ firstname: 'Ada', phone: '555-0100' });

    expect((globalThis.emitNet as any).mock.calls).toHaveLength(0);
  });

  it('refuses a payload missing a name or phone', async () => {
    await call({ firstname: '', phone: '555-0100' });
    await call({ firstname: 'Ada', phone: '' });

    expect((globalThis.emitNet as any).mock.calls).toHaveLength(0);
  });

  it('pushes the contact to every nearby, visible player', async () => {
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await call({ firstname: 'Ada', lastname: 'Lovelace', phone: '555-0100', avatar: '' });

    const incoming = pushesTo('gphone:client:contacts:incoming');
    expect(incoming).toHaveLength(1);
    expect(incoming[0][1]).toBe(9);
    expect(incoming[0][2]).toMatchObject({
      firstname: 'Ada',
      lastname: 'Lovelace',
      phone: '555-0100'
    });
  });

  it('fans out to more than one nearby player', async () => {
    proximity.nearby = [
      { source: 9, citizenid: 'CID_B' },
      { source: 11, citizenid: 'CID_C' }
    ];

    await call({ firstname: 'Ada', phone: '555-0100' });

    expect(pushesTo('gphone:client:contacts:incoming')).toHaveLength(2);
  });

  it('tells the sender how many nearby phones received it', async () => {
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await call({ firstname: 'Ada', phone: '555-0100' });

    const push = pushesTo('gphone:client:shell:appEvent');
    expect(push).toHaveLength(1);
    expect(push[0][2]).toMatchObject({
      app: 'contacts',
      event: 'share_result',
      payload: { count: 1 }
    });
  });

  it('says nobody is nearby without emitting an incoming share', async () => {
    proximity.nearby = [];

    await call({ firstname: 'Ada', phone: '555-0100' });

    expect(pushesTo('gphone:client:contacts:incoming')).toHaveLength(0);
    const push = pushesTo('gphone:client:shell:appEvent');
    expect(push[0][2]).toMatchObject({ payload: { count: 0 } });
  });

  it('clamps an oversized name and phone rather than refusing the share', async () => {
    proximity.nearby = [{ source: 9, citizenid: 'CID_B' }];

    await call({ firstname: 'A'.repeat(200), phone: '5'.repeat(200) });

    const incoming = pushesTo('gphone:client:contacts:incoming');
    expect(incoming[0][2].firstname.length).toBe(50);
    expect(incoming[0][2].phone.length).toBe(20);
  });
});
