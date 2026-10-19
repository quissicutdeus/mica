// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * The integration door (MICA-397). Every case loads the module graph fresh with the convar set
 * as the case needs, because the door reads `mica_integration` once, at import — which is what
 * "only at resource start" means here.
 *
 * The action behind the door is Casino's own, unmocked: its contract, its limiter entry, its
 * `requirePhoneFor`, its handler. Only the database and the framework's player table are
 * stand-ins, and the framework's `getPlayer` is watched, because the door must never ask it.
 *
 * The bridge stand-in follows the real one's rule for synthetic players (`installSyntheticPlayers`
 * in `lib/FrameworkBridge.ts`, proved against the real bridge in `FrameworkBridge.test.ts`): a
 * citizenid is answered from the connected players first, and from the door's resolver only on a
 * miss. So a push here finds a synthetic source the way it does in a real server.
 */

const { dbMock, bridge } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  },
  bridge: {
    getPlayer: vi.fn(),
    online: new Map<string, number>(),
    install: vi.fn(),
    synthetic: null as null | {
      player(src: number): unknown;
      sourceOf(citizenid: string): number | null;
    }
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
/** The real bridge's order: a connected character first, the door's resolver only on a miss. */
const sourceOf = (citizenid: string): number | null =>
  bridge.online.get(citizenid) ?? bridge.synthetic?.sourceOf(citizenid) ?? null;
vi.mock('../lib/FrameworkBridge', () => ({
  SYNTHETIC_SOURCE_MAX: -1_000_000,
  installSyntheticPlayers: (players: typeof bridge.synthetic) => {
    bridge.install(players);
    bridge.synthetic = players;
  },
  FrameworkBridge: {
    getPlayer: bridge.getPlayer,
    getCitizenId: () => null,
    getAllPlayers: () => ({}),
    getSourceByCitizenId: (citizenid: string) => sourceOf(citizenid),
    getSourcesByCitizenId: (citizenids: readonly string[]) => {
      const found = new Map<string, number>();
      for (const citizenid of citizenids) {
        const src = sourceOf(citizenid);
        if (src !== null) found.set(citizenid, src);
      }
      return found;
    },
    registerUsableItem: () => {}
  }
}));

type Handler = (...args: any[]) => unknown;

interface Loaded {
  local: Map<string, Handler>;
  net: Map<string, Handler>;
  emitted: unknown[][];
  casino: typeof import('../services/Casino');
  appEvents: typeof import('../lib/appEvents');
  rateLimit: typeof import('../lib/rateLimit');
  phone: typeof import('./phoneStub');
}

/** A fresh module graph, with `mica_integration` as given and every registration captured. */
const load = async (doorConvar: string): Promise<Loaded> => {
  const local = new Map<string, Handler>();
  const net = new Map<string, Handler>();
  const emitted: unknown[][] = [];
  const g = globalThis as Record<string, unknown>;
  g.on = (event: string, handler: Handler) => local.set(event, handler);
  g.onNet = (event: string, handler: Handler) => net.set(event, handler);
  g.emitNet = (...args: unknown[]) => emitted.push(args);
  g.GetConvar = (name: string, fallback: string) =>
    name === 'mica_integration' ? doorConvar : fallback;

  bridge.synthetic = null;
  bridge.install.mockClear();
  vi.resetModules();
  const casino = await import('../services/Casino');
  const appEvents = await import('../lib/appEvents');
  await import('../lib/integrationDoor');
  const rateLimit = await import('../lib/rateLimit');
  const phone = await import('./phoneStub');
  return { local, net, emitted, casino, appEvents, rateLimit, phone };
};

const DOOR_EVENTS = [
  'mica:server:integration:player',
  'mica:server:integration:invoke',
  'mica:server:integration:pushes'
];

const ask = (loaded: Loaded, event: string, ...args: unknown[]): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const handler = loaded.local.get(event);
    if (!handler) {
      reject(new Error(`${event} is not registered`));
      return;
    }
    void handler(...args, (...answer: unknown[]) => resolve(answer));
  });

let serial = 0;
const freshCitizen = () => `itx_door_${(serial += 1)}`;

const seed = async (
  loaded: Loaded,
  bank: number
): Promise<{ citizenid: string; source: number }> => {
  const citizenid = freshCitizen();
  const [answer] = await ask(loaded, 'mica:server:integration:player', citizenid, { bank });
  expect(answer).toMatchObject({ ok: true, citizenid, bank });
  return { citizenid, source: (answer as { source: number }).source };
};

const invoke = async (
  loaded: Loaded,
  citizenid: string,
  service: string,
  action: string,
  payload: unknown
): Promise<{ result: any; bank: number | null }> => {
  const [result, bank] = await ask(
    loaded,
    'mica:server:integration:invoke',
    service,
    action,
    citizenid,
    payload
  );
  return { result, bank: bank as number | null };
};

const drain = async (loaded: Loaded, citizenid: string): Promise<any[]> =>
  (await ask(loaded, 'mica:server:integration:pushes', citizenid))[0] as any[];

beforeEach(() => {
  vi.clearAllMocks();
  bridge.online.clear();
  bridge.getPlayer.mockReturnValue(null);
  let id = 0;
  dbMock.insert.mockImplementation(async () => (id += 1));
  dbMock.query.mockResolvedValue([]);
  dbMock.update.mockResolvedValue(true);
});

describe('with mica_integration off', () => {
  let loaded: Loaded;
  beforeAll(async () => {
    loaded = await load('');
  });

  it('registers no door event, locally or on the network', () => {
    for (const event of DOOR_EVENTS) {
      expect(loaded.local.has(event), event).toBe(false);
      expect(loaded.net.has(event), event).toBe(false);
    }
    // The endpoints themselves still load, so the absence is the gate and not a broken import.
    expect(loaded.net.has('mica:server:casino:spin')).toBe(true);
  });

  it('captures no push: a citizen no source answers for is offline, as it always was', () => {
    const outcome = loaded.appEvents.appEventChannel('casino').push('itx_nobody', 'crash', {});
    expect(outcome).toEqual({ delivered: false, reason: 'offline' });
  });

  it('installs no synthetic players into the bridge', () => {
    expect(bridge.install).not.toHaveBeenCalled();
    expect(bridge.synthetic).toBeNull();
  });

  it('leaves emitNet as it found it', () => {
    (globalThis as any).emitNet('mica:client:casino:spin', -1_000_000, 'cb', {});
    expect(loaded.emitted).toHaveLength(1);
  });

  it('treats any value but "1" as off', async () => {
    for (const value of ['0', 'true', ' 1', 'yes']) {
      const other = await load(value);
      expect(
        DOOR_EVENTS.some((event) => other.local.has(event)),
        value
      ).toBe(false);
    }
  });
});

describe('with mica_integration "1" at start', () => {
  let loaded: Loaded;
  beforeAll(async () => {
    loaded = await load('1');
  });
  beforeEach(() => {
    loaded.rateLimit.__resetRateLimits();
    loaded.casino.__resetCasinoForTests();
    loaded.casino.__setWheelForTests();
    loaded.casino.__setCrashDrawForTests();
    loaded.phone.installTestPhone();
    loaded.emitted.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers its three events with on() and never with onNet()', () => {
    for (const event of DOOR_EVENTS) {
      expect(loaded.local.has(event), event).toBe(true);
      expect(loaded.net.has(event), event).toBe(false);
    }
    expect([...loaded.net.keys()].filter((e) => e.includes(':integration:'))).toEqual([]);
  });

  it('installs its players into the bridge, answering only its own sources', async () => {
    const resolver = bridge.synthetic!;
    expect(resolver).not.toBeNull();
    const { citizenid, source } = await seed(loaded, 10);

    // At or below the bridge's SYNTHETIC_SOURCE_MAX, which the door writes out as -1,000,000.
    expect(source).toBeLessThanOrEqual(-1_000_000);
    expect(resolver.player(source)).toMatchObject({ citizenid, source });
    expect(resolver.sourceOf(citizenid)).toBe(source);
    // Nobody the door did not seed, and no source it did not hand out.
    expect(resolver.player(source - 1)).toBeNull();
    expect(resolver.player(5)).toBeNull();
    expect(resolver.sourceOf('itx_never_seeded')).toBeNull();
  });

  it('debits and credits the ledger through Casino’s own spin', async () => {
    const { citizenid } = await seed(loaded, 1000);
    loaded.casino.__setWheelForTests(() => 17);

    const { result, bank } = await invoke(loaded, citizenid, 'casino', 'spin', {
      bets: [
        { kind: 'straight', value: 17, amount: 10 },
        { kind: 'red', amount: 20 }
      ]
    });

    // 17 is black: the straight pays 36× its 10, the red bet loses its 20.
    expect(result).toMatchObject({ number: 17, color: 'black', stake: 30, payout: 360 });
    expect(bank).toBe(1000 - 30 + 360);
    expect(dbMock.insert).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO `mica_casino_rounds`'),
      expect.arrayContaining([citizenid, 'roulette'])
    );
    // The door hands its player to the dispatch; it never asks the framework who a source is.
    expect(bridge.getPlayer).not.toHaveBeenCalled();
    // And nothing went to the network on the synthetic player's behalf.
    expect(loaded.emitted).toEqual([]);
  });

  it('refuses a stake the ledger cannot cover, and moves nothing', async () => {
    const { citizenid } = await seed(loaded, 5);
    const { result, bank } = await invoke(loaded, citizenid, 'casino', 'spin', {
      bets: [{ kind: 'red', amount: 10 }]
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(bank).toBe(5);
  });

  it('answers a payload the contract refuses exactly as the net event answers it', async () => {
    const { citizenid } = await seed(loaded, 1000);
    const bad = { bets: [{ kind: 'red', amount: 10, payout: 9999 }] };

    const door = await invoke(loaded, citizenid, 'casino', 'spin', bad);

    // The same payload from a connected player, through the registered net event.
    bridge.getPlayer.mockImplementation((src: number) =>
      src === 7
        ? {
            citizenid: 'CID_NET',
            source: 7,
            getMoney: () => 1000,
            removeMoney: () => true,
            addMoney: () => true
          }
        : null
    );
    (globalThis as any).source = 7;
    await loaded.net.get('mica:server:casino:spin')!('cb-net', bad);
    const viaNet = loaded.emitted.find(([event]) => event === 'mica:client:casino:spin');

    expect(door.result).toHaveProperty('error');
    expect(viaNet?.[3]).toEqual(door.result);
    expect(door.bank).toBe(1000);
  });

  it('runs the limiter, keyed on the synthetic player', async () => {
    const { citizenid } = await seed(loaded, 0);
    for (let i = 0; i < 60; i += 1) {
      const { result } = await invoke(loaded, citizenid, 'casino', 'config', {});
      expect(result).toHaveProperty('bet_min');
    }
    const { result } = await invoke(loaded, citizenid, 'casino', 'config', {});
    expect(result).toEqual({
      error: 'Too many casino config requests. Slow down and try again.',
      key: 'server.rateLimited'
    });

    // Another synthetic player has a window of their own.
    const other = await seed(loaded, 0);
    expect((await invoke(loaded, other.citizenid, 'casino', 'config', {})).result).toHaveProperty(
      'bet_min'
    );
  });

  it('holds requirePhoneFor: a player holding no phone is refused before money moves', async () => {
    const { citizenid } = await seed(loaded, 1000);
    loaded.phone.refusePhone();
    const { result, bank } = await invoke(loaded, citizenid, 'casino', 'spin', {
      bets: [{ kind: 'red', amount: 10 }]
    });
    expect(result).toEqual(loaded.phone.NOT_HELD_REPLY);
    expect(bank).toBe(1000);
  });

  it('captures a push from a real handler, and drains it', async () => {
    const { citizenid, source } = await seed(loaded, 1000);
    // A draw of 1 at the default edge busts before the round starts; the push follows the reply.
    loaded.casino.__setCrashDrawForTests(() => 1);

    const { result, bank } = await invoke(loaded, citizenid, 'casino', 'crashStart', {
      stake: 100
    });
    expect(result).toMatchObject({ busted: { crash_at: 100 } });
    expect(bank).toBe(900);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const pushes = await drain(loaded, citizenid);
    expect(pushes).toEqual([
      expect.objectContaining({
        app: 'casino',
        event: 'crash',
        payload: { round_id: result.round_id, crash_at: 100 }
      })
    ]);
    expect(await drain(loaded, citizenid)).toEqual([]);
    expect(loaded.emitted).toEqual([]);
    expect(source).toBeLessThan(-1);
  });

  it('keeps the newest 200 envelopes per citizen', async () => {
    const { citizenid } = await seed(loaded, 0);
    const channel = loaded.appEvents.appEventChannel('casino');
    for (let i = 0; i < 205; i += 1) {
      expect(channel.push(citizenid, 'crash', { n: i }).delivered).toBe(true);
    }
    const pushes = await drain(loaded, citizenid);
    expect(pushes).toHaveLength(200);
    expect(pushes[0].payload).toEqual({ n: 5 });
    expect(pushes[199].payload).toEqual({ n: 204 });
  });

  it('still delivers to a connected player over the network, and captures nothing for them', async () => {
    bridge.online.set('CID_ONLINE', 12);
    const outcome = loaded.appEvents
      .appEventChannel('casino')
      .push('CID_ONLINE', 'crash', { round_id: 1 });
    expect(outcome).toEqual({ delivered: true, source: 12 });
    expect(loaded.emitted).toEqual([
      ['mica:client:shell:appEvent', 12, expect.objectContaining({ app: 'casino' })]
    ]);
  });

  it('refuses to seed a citizen who is online, or a bank that is not a sum', async () => {
    bridge.online.set('CID_LIVE', 3);
    expect(await ask(loaded, 'mica:server:integration:player', 'CID_LIVE', { bank: 1 })).toEqual([
      { ok: false, reason: 'citizen_online' }
    ]);
    for (const bank of [-1, Number.NaN, '100', undefined]) {
      expect(await ask(loaded, 'mica:server:integration:player', freshCitizen(), { bank })).toEqual(
        [{ ok: false, reason: 'bad_arguments' }]
      );
    }
  });

  it('answers an unknown action, an unknown player, and bad arguments', async () => {
    const { citizenid } = await seed(loaded, 50);
    expect(await invoke(loaded, citizenid, 'casino', 'launder', {})).toEqual({
      result: { error: 'unknown_action' },
      bank: 50
    });
    expect(await invoke(loaded, citizenid, 'nonesuch', 'get', {})).toEqual({
      result: { error: 'unknown_action' },
      bank: 50
    });
    expect(await invoke(loaded, 'itx_never_seeded', 'casino', 'config', {})).toEqual({
      result: { error: 'unknown_player' },
      bank: null
    });
    expect(await invoke(loaded, citizenid, 'casino', 42 as unknown as string, {})).toEqual({
      result: { error: 'bad_arguments' },
      bank: null
    });
  });

  it('captures an emit to a synthetic source, and passes every other target through', async () => {
    const { citizenid, source } = await seed(loaded, 0);
    const emit = (globalThis as any).emitNet as (...args: unknown[]) => unknown;

    emit('mica:client:messages:received', source, { conversation_id: 3, message: 'hi' });
    emit('mica:client:music:stop', String(source), 'a', 2);
    emit('mica:client:messages:received', 4, { conversation_id: 3 });
    emit('mica:client:messages:received', -1, { conversation_id: 3 });
    // A negative source the door never handed out is not one of its players.
    emit('mica:client:messages:received', -2_000_000, { conversation_id: 3 });

    expect(loaded.emitted).toEqual([
      ['mica:client:messages:received', 4, { conversation_id: 3 }],
      ['mica:client:messages:received', -1, { conversation_id: 3 }],
      ['mica:client:messages:received', -2_000_000, { conversation_id: 3 }]
    ]);
    expect(await drain(loaded, citizenid)).toEqual([
      {
        app: 'net',
        event: 'mica:client:messages:received',
        payload: { conversation_id: 3, message: 'hi' },
        at: expect.any(Number),
        persisted: false
      },
      {
        app: 'net',
        event: 'mica:client:music:stop',
        payload: { args: ['a', 2] },
        at: expect.any(Number),
        persisted: false
      }
    ]);
  });

  it('takes an app-event push to a synthetic source as the envelope itself', async () => {
    const { citizenid, source } = await seed(loaded, 0);
    const outcome = loaded.appEvents.appEventChannel('casino').push(citizenid, 'crash', { n: 1 });
    // The bridge answered the synthetic source, so the push was emitted, not captured offline.
    expect(outcome).toEqual({ delivered: true, source });
    expect(loaded.emitted).toEqual([]);
    expect(await drain(loaded, citizenid)).toEqual([
      expect.objectContaining({ app: 'casino', event: 'crash', payload: { n: 1 } })
    ]);
  });

  it('refuses to act for a seeded citizen once a real character connects as them', async () => {
    const { citizenid } = await seed(loaded, 1000);
    // The positive twin: before the character connects, the action runs.
    expect((await invoke(loaded, citizenid, 'casino', 'config', {})).result).toHaveProperty(
      'bet_min'
    );

    bridge.online.set(citizenid, 21);
    loaded.casino.__setWheelForTests(() => 17);
    const { result, bank } = await invoke(loaded, citizenid, 'casino', 'spin', {
      bets: [{ kind: 'red', amount: 10 }]
    });
    expect(result).toEqual({ error: 'citizen_online' });
    expect(bank).toBe(1000);
    expect(dbMock.insert).not.toHaveBeenCalledWith(
      expect.stringContaining('mica_casino_rounds'),
      expect.anything()
    );
  });

  it('re-seeds a synthetic citizen it already knows, keeping the source', async () => {
    const { citizenid, source } = await seed(loaded, 10);
    expect(await ask(loaded, 'mica:server:integration:player', citizenid, { bank: 99 })).toEqual([
      { ok: true, citizenid, source, bank: 99 }
    ]);
  });
});
