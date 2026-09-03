// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Proximity music: who is broadcasting, who can hear it, and — the part with teeth — who
 * stops being audible when nobody pressed stop.
 *
 * MICA-111 phase 2. Server code is excluded from `tsc` (AGENTS.md §1), so this file is
 * the only thing standing behind `server/services/Music.ts`.
 */

const { dbMock, handlers, gameEvents } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previousOnNet = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previousOnNet === 'function' ? previousOnNet(event, handler) : undefined;
  };

  // `playerDropped` is the stop condition that matters most, and it arrives on `on` rather
  // than `onNet` — a test that could not drive it could not prove a phantom broadcast is
  // impossible.
  const events = new Map<string, Function>();
  const previousOn = (globalThis as any).on;
  (globalThis as any).on = (event: string, handler: Function) => {
    events.set(event, handler);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };

  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured,
    gameEvents: events
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const world = vi.hoisted(() => ({
  players: {} as Record<string, unknown>,
  coords: {} as Record<string, [number, number, number]>,
  gone: new Set<number>()
}));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    // Resolved out of the fixture world rather than from the source number, because the
    // difference is the whole point of the token: one character can hold two server ids
    // across a reconnect, and two characters can never hold one citizenid.
    getPlayer: (src: number) => {
      const player = world.players[String(src)] as
        { PlayerData?: { citizenid?: string } } | undefined;
      const citizenid = player?.PlayerData?.citizenid;
      return citizenid ? { citizenid, source: src } : null;
    },
    getAllPlayers: () => world.players,
    getSourceByCitizenId: () => null,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {}
  }
}));

import { pollMusic, activeBroadcasts, __resetMusic } from '../services/Music';
import { __resetRateLimits } from '../lib/rateLimit';
import { MUSIC_BROADCAST_NET_EVENT } from '@gos/shared/musicBroadcast';
import { nearbyBroadcastFields } from '@gos/shared/musicBroadcast.fixtures';

const START = 'gos:server:music:broadcastStart';
const UPDATE = 'gos:server:music:broadcastUpdate';
const STOP = 'gos:server:music:broadcastStop';

/** A real 11-character video id shape, and a playlist one. */
const VIDEO = 'dQw4w9WgXcQ';
const OTHER_VIDEO = 'aBcDeFgHiJk';
const PLAYLIST = 'PLabcdefghijklmnopqrstuvwxyz012345';

const place = (
  src: number,
  coords: [number, number, number],
  { name = `Player${src}`, citizenid = `CID_${src}` }: { name?: string; citizenid?: string } = {}
) => {
  world.players[String(src)] = {
    PlayerData: { citizenid, charinfo: { firstname: name, lastname: 'Smith' } }
  };
  world.coords[String(src)] = coords;
};

/** Drive one endpoint action as source `src`, and let its async body settle. */
const call = async (event: string, src: number, data: unknown = {}) => {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  (globalThis as any).source = src;
  await handler(1, data);
};

const pushesTo = (src: number) =>
  (globalThis.emitNet as any).mock.calls
    .filter((c: unknown[]) => c[0] === MUSIC_BROADCAST_NET_EVENT && c[1] === src)
    .map((c: unknown[]) => c[2] as { at: number; broadcasters: any[] });

const lastPushTo = (src: number) => pushesTo(src).at(-1);

const replyTo = (event: string) =>
  (globalThis.emitNet as any).mock.calls.filter((c: unknown[]) => c[0] === event).at(-1)?.[3];

beforeEach(() => {
  vi.clearAllMocks();
  __resetMusic();
  __resetRateLimits();
  for (const key of Object.keys(world.players)) delete world.players[key];
  for (const key of Object.keys(world.coords)) delete world.coords[key];
  world.gone.clear();

  (globalThis as any).emitNet = vi.fn();
  (globalThis as any).GetPlayerPed = (src: string) => (world.coords[src] ? `ped-${src}` : null);
  (globalThis as any).GetEntityCoords = (ped: string) => world.coords[String(ped).slice(4)] ?? null;
  (globalThis as any).DoesEntityExist = (ped: string) =>
    Boolean(world.coords[String(ped).slice(4)]);
  (globalThis as any).GetPlayerName = (src: string) =>
    world.gone.has(Number(src)) ? '' : `Player${src}`;
  (globalThis as any).GetConvarInt = (_name: string, fallback: number) => fallback;
  (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
});

/**
 * §2.9: a registered net event is reachable whatever the UI does, so the ids are re-derived
 * server-side through the one parser both sides share rather than trusted from the payload.
 */
describe('what a broadcast may name', () => {
  it('refuses anything that is not a YouTube source, and starts nothing', async () => {
    place(1, [0, 0, 0]);
    await call(START, 1, { videoId: 'javascript:alert(1)' });

    expect(replyTo('gos:client:music:broadcastStart')).toEqual({
      error: 'That is not a YouTube link.',
      key: 'server.music.notYouTube'
    });
    expect(activeBroadcasts()).toEqual([]);
  });

  it('extracts the id from a pasted link rather than storing the URL', async () => {
    place(1, [0, 0, 0]);
    await call(START, 1, { url: `https://www.youtube.com/watch?v=${VIDEO}&list=${PLAYLIST}` });

    const [broadcast] = activeBroadcasts();
    expect(broadcast).toMatchObject({ source: 1, videoId: VIDEO, playlistId: PLAYLIST });
    expect(JSON.stringify(broadcast)).not.toContain('youtube.com');
  });

  it('takes ids the app already parsed, and refuses a video id of the wrong shape', async () => {
    place(1, [0, 0, 0]);
    await call(START, 1, { videoId: VIDEO });
    expect(activeBroadcasts()[0].videoId).toBe(VIDEO);

    await call(START, 1, { videoId: 'tooshort' });
    expect(replyTo('gos:client:music:broadcastStart')).toEqual({
      error: 'That is not a YouTube link.',
      key: 'server.music.notYouTube'
    });
  });
});

describe('who hears it', () => {
  it('pushes to a player in range and not to the broadcaster', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });

    expect(pushesTo(1)).toEqual([]);
    expect(lastPushTo(2)?.broadcasters).toEqual([
      {
        source: 1,
        token: expect.any(String),
        label: 'Player1 Smith',
        videoId: VIDEO,
        playlistId: null,
        startedAt: expect.any(Number),
        paused: false
      }
    ]);
  });

  it('says nothing to a player out of range, and never discloses a citizenid', async () => {
    place(1, [0, 0, 0]);
    place(2, [500, 0, 0]);
    await call(START, 1, { videoId: VIDEO });

    expect(pushesTo(2)).toEqual([]);
    expect(JSON.stringify((globalThis.emitNet as any).mock.calls)).not.toContain('CID_1');
  });

  it('tells a listener exactly once when they walk out of range', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });
    expect(pushesTo(2)).toHaveLength(1);

    world.coords['2'] = [500, 0, 0];
    pollMusic();
    expect(lastPushTo(2)?.broadcasters).toEqual([]);

    // And then stays quiet: an empty roster is not re-sent every two seconds forever.
    pollMusic();
    pollMusic();
    expect(pushesTo(2)).toHaveLength(2);
  });

  it('sends nothing at all while nobody is broadcasting', () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    pollMusic();
    expect((globalThis.emitNet as any).mock.calls).toEqual([]);
  });

  it('repeats nothing when what a listener can hear has not changed', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });

    pollMusic();
    pollMusic();
    expect(pushesTo(2)).toHaveLength(1);
  });

  /**
   * The cap is a *roster* cap and the rule is nearest-first, stated in the code rather than
   * emerging from iteration order — MICA-111's comment promotes both to requirements,
   * because an uncapped roster is a client with an unbounded number of embeds.
   */
  it('keeps the nearest broadcasters and drops the rest at the cap', async () => {
    place(10, [0, 0, 0]); // the listener
    place(1, [20, 0, 0]);
    place(2, [2, 0, 0]);
    place(3, [8, 0, 0]);
    await call(START, 1, { videoId: VIDEO });
    await call(START, 2, { videoId: OTHER_VIDEO });
    await call(START, 3, { playlistId: PLAYLIST });

    (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
      name === 'gos_music_max_nearby' ? 2 : fallback;
    pollMusic();

    expect(lastPushTo(10)?.broadcasters.map((b: any) => b.source)).toEqual([2, 3]);
  });

  it('clamps the roster convar to the ceiling rather than honouring any number', async () => {
    place(10, [0, 0, 0]);
    for (let src = 1; src <= 18; src += 1) place(src, [1, 0, 0]);
    for (let src = 1; src <= 18; src += 1) await call(START, src, { videoId: VIDEO });

    (globalThis as any).GetConvarInt = (name: string, fallback: number) =>
      name === 'gos_music_max_nearby' ? 999 : fallback;
    pollMusic();

    expect(lastPushTo(10)?.broadcasters.length).toBe(16);
  });
});

/**
 * The mute key, and the reason it is neither of the two obvious values.
 *
 * A mute keyed on the server id is void the moment its target relogs — the one person a
 * mute is for — and, ids being reused, would eventually silence somebody innocent. A mute
 * keyed on the citizenid would work and would put a cross-session correlation handle for
 * every broadcaster in front of every nearby client, which is what the repo's public
 * projections strip on purpose.
 */
describe('the broadcaster token', () => {
  it('survives a reconnect on a different server id', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });
    const before = lastPushTo(2)!.broadcasters[0].token;

    // Same character, new connection: FiveM hands out a different source.
    (globalThis as any).source = 1;
    gameEvents.get('playerDropped')!();
    delete world.players['1'];
    delete world.coords['1'];
    place(7, [0, 0, 0], { name: 'Player1', citizenid: 'CID_1' });
    await call(START, 7, { videoId: VIDEO });

    expect(lastPushTo(2)!.broadcasters[0].token).toBe(before);
    expect(lastPushTo(2)!.broadcasters[0].source).toBe(7);
  });

  it('gives two characters two tokens', async () => {
    place(10, [0, 0, 0]);
    place(1, [1, 0, 0]);
    place(2, [2, 0, 0]);
    await call(START, 1, { videoId: VIDEO });
    await call(START, 2, { videoId: OTHER_VIDEO });

    const tokens = lastPushTo(10)!.broadcasters.map((b: any) => b.token);
    expect(new Set(tokens).size).toBe(2);
  });

  it('is not derived from the citizenid it stands for', async () => {
    // A hash under a constant salt would be reversible by anyone holding the repo, so the
    // token is looked up rather than computed — and nothing of the citizenid is in it.
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });

    const { token } = lastPushTo(2)!.broadcasters[0];
    expect(token).not.toContain('CID_1');
    expect(token.length).toBeGreaterThan(8);
  });
});

/**
 * The producing end of the shared fixture every hop's tests are built from.
 *
 * The other three layers assert against `nearbyBroadcastFixture()`; this is the one place
 * that can check the server actually *emits* that shape. A field added to the row and not
 * to this payload — or sent under a name the consumers do not read — fails here rather
 * than surviving three green suites and being found by somebody reading two files side by
 * side, which is how the `id`/`token` and `name`/`label` drift was found the slow way.
 */
describe('the wire shape', () => {
  it('sends exactly the fields the shared fixture describes', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });

    const row = lastPushTo(2)!.broadcasters[0];
    expect(Object.keys(row).sort()).toEqual(nearbyBroadcastFields());
  });
});

describe('sync', () => {
  it('anchors startedAt to the position the broadcaster reported', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    const before = Date.now();
    await call(START, 1, { videoId: VIDEO, positionMs: 30_000 });

    const { startedAt } = lastPushTo(2)!.broadcasters[0];
    expect(before - startedAt).toBeGreaterThanOrEqual(29_000);
    expect(Date.now() - startedAt).toBeLessThan(35_000);
  });

  it('ignores a re-announcement of the same track at nearly the same position', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });
    const first = activeBroadcasts()[0].startedAt;

    // The same track, a few hundred ms of latency later. A seek would drag every listener
    // back by exactly the round trip it took to say nothing had changed.
    await call(START, 1, { videoId: VIDEO, positionMs: 300 });
    expect(activeBroadcasts()[0].startedAt).toBe(first);
    expect(pushesTo(2)).toHaveLength(1);
  });

  it('moves everyone when the position really is a seek', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });
    await call(UPDATE, 1, { positionMs: 120_000 });

    const startedAt = lastPushTo(2)!.broadcasters.at(-1).startedAt;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(119_000);
    expect(pushesTo(2)).toHaveLength(2);
  });

  it('freezes the position while paused, so a listener joining seeks to where it stopped', async () => {
    place(1, [0, 0, 0]);
    await call(START, 1, { videoId: VIDEO, positionMs: 45_000 });
    await call(UPDATE, 1, { paused: true });

    // Somebody walks up afterwards. Their seek must be ~45s, not 45s plus however long it
    // has been sitting paused.
    place(2, [5, 0, 0]);
    pollMusic();

    const row = lastPushTo(2)!.broadcasters[0];
    expect(row.paused).toBe(true);
    const positionMs = lastPushTo(2)!.at - row.startedAt;
    expect(positionMs).toBeGreaterThanOrEqual(44_000);
    expect(positionMs).toBeLessThan(50_000);
  });

  it('resumes where it stopped rather than where it would have been', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO, positionMs: 10_000 });
    await call(UPDATE, 1, { paused: true });
    await call(UPDATE, 1, { paused: false });

    const row = lastPushTo(2)!.broadcasters[0];
    expect(row.paused).toBe(false);
    const positionMs = Date.now() - row.startedAt;
    expect(positionMs).toBeGreaterThanOrEqual(9_000);
    expect(positionMs).toBeLessThan(15_000);
  });

  it('bounds a client-supplied position instead of taking any number', async () => {
    place(1, [0, 0, 0]);
    const before = Date.now();
    await call(START, 1, { videoId: VIDEO, positionMs: Number.MAX_SAFE_INTEGER });

    // Twelve hours is the bound; anything past it would put `startedAt` in an era.
    // Measured against `before` rather than a fresh `Date.now()`: `startedAt` is
    // `now - 12h`, so a clock that ticks by a millisecond between the call and the
    // assertion makes the naive comparison fail — which is a flake, not a bug.
    const backdatedBy = before - activeBroadcasts()[0].startedAt;
    expect(backdatedBy).toBeLessThanOrEqual(12 * 3600 * 1000);
    expect(backdatedBy).toBeGreaterThan(11 * 3600 * 1000);

    // A position that is not a number at all is refused outright now, rather than read as
    // zero: "the client sent nothing usable" and "the track is at the start" are different
    // statements, and silently turning the first into the second is how a broadcast ends up
    // resynchronising every listener to a position nobody asked for.
    await call(START, 1, { videoId: OTHER_VIDEO, positionMs: 'not a number' });
    expect(activeBroadcasts()[0].videoId).toBe(VIDEO);
  });
});

describe('when a broadcast ends', () => {
  it('stops on request, and tells the people who could hear it', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });
    await call(STOP, 1);

    expect(activeBroadcasts()).toEqual([]);
    expect(lastPushTo(2)?.broadcasters).toEqual([]);
  });

  it('does not treat a second stop as an error', async () => {
    place(1, [0, 0, 0]);
    await call(STOP, 1);
    expect(replyTo('gos:client:music:broadcastStop')).toEqual({ ok: true });
  });

  /**
   * The failure this whole design is guarding against: somebody disconnects and a stereo
   * nobody can see keeps playing for everyone standing where they used to be.
   */
  it('ends on disconnect, immediately, and does not leave a phantom', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });

    delete world.players['1'];
    delete world.coords['1'];
    world.gone.add(1);
    (globalThis as any).source = 1;
    gameEvents.get('playerDropped')!();

    expect(activeBroadcasts()).toEqual([]);
    expect(lastPushTo(2)?.broadcasters).toEqual([]);
  });

  /**
   * Belt and braces for the same thing: `playerDropped` can be missed (a crash, a resource
   * restarted underneath it), so the poll refuses to fan out for a source the server can no
   * longer name — the same `GetPlayerName` check `Signal.ts` makes before `emitNet`.
   */
  it('drops a broadcaster the server can no longer name, even with no playerDropped', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });

    world.gone.add(1);
    pollMusic();

    expect(activeBroadcasts()).toEqual([]);
    expect(lastPushTo(2)?.broadcasters).toEqual([]);
  });

  it('keeps a broadcast whose owner has no ped for a moment, but nobody hears it', async () => {
    place(1, [0, 0, 0]);
    place(2, [5, 0, 0]);
    await call(START, 1, { videoId: VIDEO });

    // Between characters, or mid-respawn: still connected, no ped to measure from.
    delete world.coords['1'];
    pollMusic();

    expect(activeBroadcasts()).toHaveLength(1);
    expect(lastPushTo(2)?.broadcasters).toEqual([]);
  });

  it('answers an update from somebody who is not broadcasting rather than inventing one', async () => {
    place(1, [0, 0, 0]);
    await call(UPDATE, 1, { paused: true });
    expect(replyTo('gos:client:music:broadcastUpdate')).toEqual({
      ok: false,
      reason: 'not_broadcasting'
    });
    expect(activeBroadcasts()).toEqual([]);
  });
});

describe('the boundary', () => {
  /**
   * §2.9: starting a broadcast is cheap to spam and a registered event is reachable
   * regardless of the UI. The limiter sits at the `registerEvent` boundary, so this is
   * really a check that the action goes through the endpoint rather than a raw `onNet`.
   */
  it('rate-limits a broadcast storm and says why', async () => {
    place(1, [0, 0, 0]);
    for (let i = 0; i < 61; i += 1) await call(START, 1, { videoId: VIDEO });

    expect(replyTo('gos:client:music:broadcastStart')).toEqual({
      error: 'Too many music broadcastStart requests. Slow down and try again.',
      key: 'server.rateLimited'
    });
  });

  it('registers no generic CRUD action, because none of them would mean anything', () => {
    // §2.9: a registered event is reachable whether or not any route points at it, so a
    // service with no table must not leave `create`/`update`/`delete` lying around.
    for (const action of ['get', 'create', 'update', 'delete']) {
      expect(handlers.has(`gos:server:music:${action}`)).toBe(false);
    }
  });

  it('refuses a caller with no loaded character', async () => {
    // No `place()`, so `FrameworkBridge.getPlayer` answers null.
    await call(START, 99, { videoId: VIDEO });
    expect(replyTo('gos:client:music:broadcastStart')).toEqual({
      error: 'Player not authenticated',
      key: 'server.notAuthenticated'
    });
    expect(activeBroadcasts()).toEqual([]);
  });
});
