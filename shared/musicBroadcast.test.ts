// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()`, and do not
// "simplify" this line away by giving that predicate a `typeof` guard — MICA-177 is the
// bug and carries the reasoning, including why both cheap guards are worse than the crash.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../web/src/host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseMusicBroadcasts, parseMusicBroadcastVolumes } from './nui';
import { MUSIC_BROADCASTS_NUI_ACTION, MUSIC_BROADCAST_VOLUMES_NUI_ACTION } from './musicBroadcast';
import { nearbyBroadcastFixture } from './musicBroadcast.fixtures';

/**
 * One fixture, driven through **both** hops of MICA-111 phase 2.
 *
 * ## Why this file exists, and why it is not in `client/__tests__` or `web/src`
 *
 * Every other test of this feature asserts against one end's own vocabulary.
 * `client/__tests__/Music.test.ts` builds a roster row and checks what goes out; the
 * shell's suites build a NUI payload by hand and check what the stores do with it. Both
 * were green, simultaneously, while the join between them was broken and **no nearby music
 * would have played in game for anybody** — the roster keyed on one identity and the volume
 * lookup on another, each end perfectly self-consistent. A test per side can never catch a
 * disagreement *between* sides: it is AGENTS.md §8's missing-layer failure in miniature,
 * and the reason that section exists.
 *
 * So this drives the real `client/services/Music.ts`, over the real `SendNuiMessage`
 * envelope, through the real `shared/nui.ts` parsers, into the real shell stores. Nothing
 * between the net event and `audibleBroadcasts` is stubbed except the game natives, which
 * have no implementation to borrow.
 *
 * It lives in `shared/` because that is the only directory both halves may be imported
 * from: the root Vitest project has no Svelte and cannot load the shell's stores, and
 * `web/`'s project already collects the `../shared` test glob (`web/vite.config.ts`).
 *
 * ## Two things this file deliberately does not import
 *
 * **Svelte.** It reads the shell's stores through `subscribe`, which is the whole of the
 * readable-store contract, rather than `get` from `svelte/store`. Partly because that is
 * the honest dependency — this asserts against a contract, not against a library — and
 * partly because `shared/` belongs to knip's root workspace, which has no Svelte in it, so
 * the import failed `pnpm deadcode` as an unlisted dependency. Reaching for a knip
 * exception would have been the wrong fix for a dependency this file does not need.
 *
 * **A hand-rolled roster row.** `nearbyBroadcastFixture` is the one definition, shared with
 * the server's and the shell's suites. A field renamed on the wire now breaks every hop's
 * tests at once instead of leaving three green suites disagreeing with each other, which is
 * exactly the failure that occasioned this file.
 *
 * ## The property being pinned
 *
 * Not "the key is called `source`" — that is an implementation detail either end may
 * revise. It is: **a broadcaster the server announced ends up audible at the volume the
 * client computed for them.** Any re-keying on either side that breaks the join fails this,
 * whatever the new key is named.
 */

/**
 * The two identities of the fixture's broadcaster, read back rather than restated.
 *
 * They are different *kinds* of value, which is what makes a mixed-up join fail here rather
 * than pass by coincidence: `Number(TOKEN)` is `NaN`, so a volume map keyed on the token
 * cannot be looked up by source, or the reverse.
 */
const { source: SOURCE, token: TOKEN } = nearbyBroadcastFixture();

const broadcaster = (over: Record<string, unknown> = {}) =>
  ({ ...nearbyBroadcastFixture(), startedAt: Date.now() - 30_000, ...over }) as Record<
    string,
    unknown
  >;

/**
 * Read a readable store once.
 *
 * `subscribe` fires synchronously with the current value on subscribe, which is the entire
 * behaviour `get` wraps — and doing it here keeps Svelte out of `shared/`. See the header.
 */
const read = <T>(store: { subscribe: (run: (value: T) => void) => () => void }): T => {
  let value: T | undefined;
  const stop = store.subscribe((v) => {
    value = v;
  });
  stop();
  return value as T;
};

let tickCallbacks: Map<number, () => void>;
let nextTickId: number;
let now: number;
let sentNuiMessages: { action: string; data: unknown }[];
let netSubscriptions: Map<string, (data: unknown) => void>;
/** Server id → world position. The broadcaster stands 6m from the listener. */
let peds: Map<number, [number, number, number]>;

const installNatives = () => {
  const g = globalThis as Record<string, unknown>;
  g.onNet = (event: string, handler: (data: unknown) => void) =>
    netSubscriptions.set(event, handler);
  g.SendNuiMessage = (payload: unknown) => sentNuiMessages.push(JSON.parse(payload as string));
  g.PlayerId = () => 0;
  g.GetPlayerServerId = () => 1;
  g.PlayerPedId = () => 1;
  g.setTick = (cb: () => void) => {
    const id = ++nextTickId;
    tickCallbacks.set(id, cb);
    return id;
  };
  g.clearTick = (id: number) => tickCallbacks.delete(id);
  g.GetGameTimer = () => now;
  g.GetFrameTime = () => 0.016;
  g.GetConvarInt = (_name: string, fallback: number) => fallback;
  g.GetPlayerFromServerId = (source: number) => (peds.has(source) ? 100 + source : -1);
  g.GetPlayerPed = (player: number) => (player === -1 ? 0 : player);
  g.GetEntityCoords = (entity: number) => {
    if (entity === 1) return [0, 0, 0];
    const coords = peds.get(entity - 100);
    return coords ? [...coords] : [];
  };
};

/** Run the attenuation tick until the volume has settled. */
const settle = () => {
  for (let i = 0; i < 300; i += 1) {
    now += 16;
    for (const cb of tickCallbacks.values()) cb();
  }
};

/** Everything the client sent, replayed into the shell exactly as `nuiMessages.ts` routes it. */
const deliverToShell = async () => {
  const shell = await import('../web/src/shell/state/nearbyMusic');
  for (const message of sentNuiMessages) {
    if (message.action === MUSIC_BROADCASTS_NUI_ACTION) {
      const list = parseMusicBroadcasts(message.data);
      if (list) shell.receiveNearbyBroadcasts(list);
    } else if (message.action === MUSIC_BROADCAST_VOLUMES_NUI_ACTION) {
      const volumes = parseMusicBroadcastVolumes(message.data);
      if (volumes) shell.receiveNearbyVolumes(volumes);
    }
  }
  return shell;
};

/** Announce one broadcaster from the server and let both hops run. */
const announce = async (rows: Record<string, unknown>[]) => {
  const receive = netSubscriptions.get('gphone:client:shell:music');
  if (!receive) throw new Error('client/services/Music.ts did not subscribe to the net event');
  receive({ at: Date.now(), broadcasters: rows });
  settle();
  return deliverToShell();
};

beforeEach(async () => {
  vi.resetModules();
  // MICA-176: `resetModules` discarded the facet registry — see `motion.test.ts`'s note.
  await import('../web/src/host/registerFacets');
  tickCallbacks = new Map();
  nextTickId = 0;
  now = 1000;
  sentNuiMessages = [];
  netSubscriptions = new Map();
  peds = new Map([[SOURCE, [6, 0, 0] as [number, number, number]]]);
  installNatives();

  const shell = await import('../web/src/shell/state/nearbyMusic');
  shell.resetNearbyMusicForTest();
  await import('../client/services/Music');
});

describe('a broadcast, end to end', () => {
  it('arrives audible at the volume the game client computed for it', async () => {
    const shell = await announce([broadcaster()]);

    // The volume the client actually put on the wire, read back from the message itself
    // rather than recomputed here — recomputing would let both sides drift together.
    const sent = sentNuiMessages.filter((m) => m.action === MUSIC_BROADCAST_VOLUMES_NUI_ACTION);
    const volumes = (sent.at(-1)!.data as { volumes: Record<string, number> }).volumes;
    const computed = Object.values(volumes)[0];
    expect(computed).toBeGreaterThan(0.5);

    const audible = read(shell.audibleBroadcasts);
    expect(audible).toHaveLength(1);
    expect(audible[0].token).toBe(TOKEN);
    expect(audible[0].source).toBe(SOURCE);
    // The property this whole file exists for.
    expect(audible[0].attenuation).toBeCloseTo(computed, 6);
  });

  it('is silent when the listener is out of range, without dropping off the roster', async () => {
    peds.set(SOURCE, [500, 0, 0]);
    const shell = await announce([broadcaster()]);

    // Still known — the server said they are nearby, and the mute list needs to name them.
    expect(read(shell.nearbyBroadcasts)).toHaveLength(1);
    // Just not making any noise.
    expect(read(shell.audibleBroadcasts)).toHaveLength(0);
  });

  it('is silenced by a mute keyed on the token, while the volume keys on the source', async () => {
    const shell = await announce([broadcaster()]);
    expect(read(shell.audibleBroadcasts)).toHaveLength(1);

    // The two identities are not interchangeable, and this is where that is load-bearing:
    // muting by the server id must not work, and muting by the token must.
    shell.muteBroadcaster(String(SOURCE));
    expect(read(shell.audibleBroadcasts)).toHaveLength(1);

    shell.muteBroadcaster(TOKEN);
    expect(read(shell.audibleBroadcasts)).toHaveLength(0);
  });

  it('gives a muted broadcaster no slot, so the next-nearest is heard instead', async () => {
    peds.set(8, [10, 0, 0]);
    const shell = await announce([
      broadcaster(),
      broadcaster({ source: 8, token: 'k8p2vn5rq9y4', videoId: 'oHg5SJYRHA0' })
    ]);

    const before = read(shell.audibleBroadcasts);
    expect(before.map((b) => b.token)).toEqual([TOKEN, 'k8p2vn5rq9y4']);

    // Muting the nearest is how you hear the next one — it must not leave a silent slot.
    shell.muteBroadcaster(TOKEN);
    const after = read(shell.audibleBroadcasts);
    expect(after.map((b) => b.token)).toEqual(['k8p2vn5rq9y4']);
    expect(after[0].attenuation).toBeGreaterThan(0);
  });

  it('stops the music when the server stops naming the broadcaster', async () => {
    const shell = await announce([broadcaster()]);
    expect(read(shell.audibleBroadcasts)).toHaveLength(1);

    sentNuiMessages = [];
    await announce([]);

    expect(read(shell.nearbyBroadcasts)).toHaveLength(0);
    expect(read(shell.audibleBroadcasts)).toHaveLength(0);
  });

  it('never lets a broadcast with no mute token reach the shell', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shell = await announce([broadcaster({ token: undefined })]);

    // Both hops refuse it independently. Playing it would make its broadcaster unmuteable,
    // which is the whole reason the token exists.
    expect(read(shell.nearbyBroadcasts)).toHaveLength(0);
    expect(read(shell.audibleBroadcasts)).toHaveLength(0);
    error.mockRestore();
  });
});
