import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The attenuation half of MICA-111 phase 2.
 *
 * Everything this file asserts is a decision somebody could otherwise only check by
 * standing in a road in game and listening — the shape of the curve, that the tick is not
 * running when nobody is broadcasting, that the volume ramps instead of stepping. None of
 * that is provable by `pnpm typecheck` and none of it is reachable from Playwright, which
 * never loads `client/`.
 *
 * Manual FiveM stubs rather than `server/__tests__/setup.ts`'s, following `Call.test.ts`:
 * those are `noop`s, and this needs to capture the tick callback and drive it frame by
 * frame with a clock it controls.
 */

let tickCallbacks: Map<number, () => void>;
let nextTickId: number;
let clearedTicks: number[];
let now: number;
let frameTime: number;
let convars: Record<string, number>;
/** Server id → world position, or absent for a ped this client cannot see. */
let peds: Map<number, [number, number, number]>;
let localCoords: [number, number, number];

const installGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  g.setTick = (cb: () => void) => {
    const id = ++nextTickId;
    tickCallbacks.set(id, cb);
    return id;
  };
  g.clearTick = (id: number) => {
    clearedTicks.push(id);
    tickCallbacks.delete(id);
  };
  g.GetGameTimer = () => now;
  g.GetFrameTime = () => frameTime;
  g.GetConvarInt = (name: string, fallback: number) => convars[name] ?? fallback;
  g.PlayerPedId = () => 1;
  g.GetPlayerFromServerId = (source: number) => (peds.has(source) ? 100 + source : -1);
  g.GetPlayerPed = (player: number) => (player === -1 ? 0 : player);
  g.GetEntityCoords = (entity: number) => {
    if (entity === 1) return [...localCoords];
    const source = entity - 100;
    const coords = peds.get(source);
    return coords ? [...coords] : [];
  };
};

/** Run one frame of every live tick. */
const frame = (ms = 16) => {
  now += ms;
  frameTime = ms / 1000;
  for (const cb of tickCallbacks.values()) cb();
};

const load = async () => {
  vi.resetModules();
  return import('../game/MusicProximity');
};

beforeEach(() => {
  tickCallbacks = new Map();
  nextTickId = 0;
  clearedTicks = [];
  now = 1000;
  frameTime = 1 / 60;
  convars = {};
  peds = new Map();
  localCoords = [0, 0, 0];
  installGlobals();
});

describe('musicAttenuation', () => {
  it('is silent at and beyond the range boundary, and full inside the near field', async () => {
    const { musicAttenuation } = await load();

    expect(musicAttenuation(0, 30)).toBe(1);
    expect(musicAttenuation(2, 30)).toBe(1);
    expect(musicAttenuation(30, 30)).toBe(0);
    expect(musicAttenuation(45, 30)).toBe(0);
  });

  it('falls faster than linear, which is the whole reason it is not linear', async () => {
    const { musicAttenuation } = await load();

    // Four fifths of the way across the band, a linear curve is still at 0.2 — audible,
    // unidentifiable, and following you around. The quadratic is an order of magnitude
    // quieter there.
    const range = 30;
    const band = range - 2;
    const fourFifths = 2 + band * 0.8;
    expect(musicAttenuation(fourFifths, range)).toBeLessThan(0.05);

    // Half way across is a quarter, not a half.
    expect(musicAttenuation(2 + band * 0.5, range)).toBeCloseTo(0.25, 6);
  });

  it('is monotone decreasing across the whole band', async () => {
    const { musicAttenuation } = await load();

    let previous = 1;
    for (let d = 2; d <= 30; d += 0.5) {
      const value = musicAttenuation(d, 30);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBe(0);
  });

  it('refuses nonsense rather than propagating it into a per-frame tick', async () => {
    const { musicAttenuation } = await load();

    expect(musicAttenuation(Number.NaN, 30)).toBe(0);
    expect(musicAttenuation(-5, 30)).toBe(0);
    expect(musicAttenuation(1, 0)).toBe(0);
    expect(musicAttenuation(1, Number.NaN)).toBe(0);
    // A range inside the flat near field degenerates to audible-or-not.
    expect(musicAttenuation(0.5, 1)).toBe(1);
    expect(musicAttenuation(1.5, 1)).toBe(0);
  });
});

describe('MusicProximity', () => {
  it('does not create a tick when there is nothing to attenuate', async () => {
    const { MusicProximity } = await load();
    const updates: unknown[][] = [];
    MusicProximity.onUpdate((levels) => updates.push(levels));

    MusicProximity.setSources([]);

    expect(tickCallbacks.size).toBe(0);
    // The empty push still happens, so the shell is told to stop rather than left holding
    // whatever it had.
    expect(updates).toEqual([[]]);
  });

  it('runs a tick while somebody is broadcasting and clears it when they stop', async () => {
    const { MusicProximity } = await load();
    MusicProximity.onUpdate(() => {});
    peds.set(7, [5, 0, 0]);

    MusicProximity.setSources([7]);
    expect(tickCallbacks.size).toBe(1);

    MusicProximity.setSources([]);
    // Still ticking: the entry is fading rather than vanishing.
    expect(tickCallbacks.size).toBe(1);

    for (let i = 0; i < 200; i += 1) frame();

    expect(tickCallbacks.size).toBe(0);
    expect(clearedTicks.length).toBeGreaterThan(0);
  });

  it('ramps the volume instead of stepping to it', async () => {
    const { MusicProximity, musicAttenuation } = await load();
    const updates: { source: number; volume: number }[][] = [];
    MusicProximity.onUpdate((levels) =>
      updates.push(levels.map(({ source, volume }) => ({ source, volume })))
    );

    peds.set(7, [5, 0, 0]);
    MusicProximity.setSources([7]);

    const target = musicAttenuation(5, 30);
    expect(target).toBeGreaterThan(0.5);

    frame();
    const first = updates.at(-1)![0].volume;
    // One frame closes a fraction of the gap, not the whole thing — a volume that arrived
    // in one step would be the "sounds like a fault" case.
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(target * 0.2);

    for (let i = 0; i < 200; i += 1) frame();
    // Settles to within PUSH_EPSILON of the true target and stops there — the guarantee
    // the convergence gate exists to give, and the reason it is not "changed since the
    // last push", which would strand the value wherever the throttle happened to stop.
    expect(Math.abs(updates.at(-1)![0].volume - target)).toBeLessThan(0.01);
  });

  it('stops pushing once the volume has settled, and resumes when the listener moves', async () => {
    const { MusicProximity } = await load();
    let pushes = 0;
    MusicProximity.onUpdate(() => {
      pushes += 1;
    });

    peds.set(7, [5, 0, 0]);
    MusicProximity.setSources([7]);
    for (let i = 0; i < 300; i += 1) frame();

    const settled = pushes;
    for (let i = 0; i < 60; i += 1) frame();
    expect(pushes).toBe(settled);

    localCoords = [20, 0, 0];
    for (let i = 0; i < 20; i += 1) frame();
    expect(pushes).toBeGreaterThan(settled);
  });

  it('scores a broadcaster this client cannot see as silent rather than as adjacent', async () => {
    const { MusicProximity } = await load();
    const updates: { source: number; volume: number; distance: number | null }[][] = [];
    MusicProximity.onUpdate((levels) => updates.push(levels.map((l) => ({ ...l }))));

    // No entry in `peds`: `GetPlayerFromServerId` answers -1, the way it does for a player
    // who is not streamed in or is in another routing bucket.
    MusicProximity.setSources([7]);
    for (let i = 0; i < 60; i += 1) frame();

    const last = updates.at(-1)!;
    expect(last).toHaveLength(1);
    expect(last[0].volume).toBe(0);
    expect(last[0].distance).toBeNull();
  });

  it('reports nearest first, with the unlocatable behind everyone it can measure', async () => {
    const { MusicProximity } = await load();
    const updates: { source: number }[][] = [];
    MusicProximity.onUpdate((levels) => updates.push(levels.map(({ source }) => ({ source }))));

    peds.set(7, [12, 0, 0]);
    peds.set(8, [3, 0, 0]);
    MusicProximity.setSources([7, 8, 9]);
    frame();

    expect(updates.at(-1)!.map((l) => l.source)).toEqual([8, 7, 9]);
  });

  it('counts height, so a floor between you is quieter', async () => {
    const { MusicProximity } = await load();
    const updates: { source: number; volume: number }[][] = [];
    MusicProximity.onUpdate((levels) =>
      updates.push(levels.map(({ source, volume }) => ({ source, volume })))
    );

    peds.set(7, [3, 0, 0]);
    peds.set(8, [3, 0, 12]);
    MusicProximity.setSources([7, 8]);
    for (let i = 0; i < 200; i += 1) frame();

    const last = updates.at(-1)!;
    const ground = last.find((l) => l.source === 7)!.volume;
    const upstairs = last.find((l) => l.source === 8)!.volume;
    expect(upstairs).toBeLessThan(ground);
    expect(upstairs).toBeGreaterThan(0);
  });

  it('fades a departing broadcaster out rather than cutting it', async () => {
    const { MusicProximity } = await load();
    const updates: { source: number; volume: number }[][] = [];
    MusicProximity.onUpdate((levels) =>
      updates.push(levels.map(({ source, volume }) => ({ source, volume })))
    );

    peds.set(7, [3, 0, 0]);
    MusicProximity.setSources([7]);
    for (let i = 0; i < 300; i += 1) frame();
    const before = updates.at(-1)![0].volume;
    expect(before).toBeGreaterThan(0.5);

    MusicProximity.setSources([]);
    frame();

    const during = updates.at(-1)!;
    // Still present, and quieter — not gone, and not still at full volume.
    expect(during).toHaveLength(1);
    expect(during[0].volume).toBeLessThan(before);
    expect(during[0].volume).toBeGreaterThan(0);

    for (let i = 0; i < 300; i += 1) frame();
    expect(updates.at(-1)).toEqual([]);
  });

  it('holds a broadcaster loitering on the edge of range at silence, rather than flickering', async () => {
    const { MusicProximity } = await load();
    const updates: { volume: number }[][] = [];
    MusicProximity.onUpdate((levels) => updates.push(levels.map(({ volume }) => ({ volume }))));

    // Just outside the 30m default: silent, and latched off.
    peds.set(7, [30.5, 0, 0]);
    MusicProximity.setSources([7]);
    for (let i = 0; i < 200; i += 1) frame();
    expect(updates.at(-1)![0].volume).toBe(0);

    // A step inside. Bare attenuation is now above zero, but below the deadband, so it
    // stays silent — the shell filters silence before it ranks, so a volume crossing zero
    // is an iframe created and destroyed, not a re-render.
    peds.set(7, [29, 0, 0]);
    for (let i = 0; i < 200; i += 1) frame();
    expect(updates.at(-1)![0].volume).toBe(0);

    // Genuinely closer: clears the deadband and becomes audible.
    peds.set(7, [20, 0, 0]);
    for (let i = 0; i < 200; i += 1) frame();
    expect(updates.at(-1)![0].volume).toBeGreaterThan(0.05);

    // And once latched on it stays on, back out past where it refused to switch on.
    peds.set(7, [29, 0, 0]);
    for (let i = 0; i < 200; i += 1) frame();
    expect(updates.at(-1)![0].volume).toBeGreaterThan(0);
  });

  it('honours gphone_music_range, clamped so a bad value cannot make the tick meaningless', async () => {
    const { MusicProximity } = await load();
    const updates: { volume: number }[][] = [];
    MusicProximity.onUpdate((levels) => updates.push(levels.map(({ volume }) => ({ volume }))));

    convars.gphone_music_range = 10;
    peds.set(7, [20, 0, 0]);
    MusicProximity.setSources([7]);
    for (let i = 0; i < 200; i += 1) frame();

    // 20m away with a 10m range is silence, where the 30m default would have been audible.
    expect(updates.at(-1)![0].volume).toBe(0);
  });

  it('clamps an absurd range rather than trusting the convar', async () => {
    const { MusicProximity } = await load();
    const updates: { volume: number }[][] = [];
    MusicProximity.onUpdate((levels) => updates.push(levels.map(({ volume }) => ({ volume }))));

    convars.gphone_music_range = 100000;
    peds.set(7, [200, 0, 0]);
    MusicProximity.setSources([7]);
    for (let i = 0; i < 200; i += 1) frame();

    // 200m is past the 150m ceiling, so it is silent however the convar was set.
    expect(updates.at(-1)![0].volume).toBe(0);
  });

  it('closes the same fraction of the gap per second at any framerate', async () => {
    const { MusicProximity } = await load();

    const runAt = async (ms: number) => {
      tickCallbacks = new Map();
      nextTickId = 0;
      now = 1000;
      const mod = await load();
      let last = 0;
      mod.MusicProximity.onUpdate((levels) => {
        if (levels.length) last = levels[0].volume;
      });
      peds.set(7, [3, 0, 0]);
      mod.MusicProximity.setSources([7]);
      // Half a second of wall clock, however many frames that is.
      for (let elapsed = 0; elapsed < 500; elapsed += ms) frame(ms);
      return last;
    };

    const slow = await runAt(33);
    const fast = await runAt(8);
    // A 30fps client and a 125fps one are at the same point half a second in, which is the
    // property `GetFrameTime`-based smoothing exists to have.
    expect(Math.abs(slow - fast)).toBeLessThan(0.05);
    expect(MusicProximity).toBeTruthy();
  });
});
