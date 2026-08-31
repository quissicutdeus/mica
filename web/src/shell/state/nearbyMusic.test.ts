// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()` — see the commit
// message for why teaching that predicate to tolerate a missing `window` is the worse fix.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  audibleBroadcasts,
  muteAllNearby,
  clearMutedBroadcasters,
  muteBroadcaster,
  mutedBroadcasters,
  nearbyBroadcastCount,
  nearbyBroadcasts,
  receiveNearbyBroadcasts,
  receiveNearbyVolumes,
  resetNearbyMusicForTest,
  setMuteAllNearby,
  toggleBroadcasterMute,
  unmuteBroadcaster
} from './nearbyMusic';
import {
  INCUMBENT_MARGIN,
  MAX_AUDIBLE_BROADCASTS,
  joinOffsetSeconds
} from '../../lib/sdk/musicBroadcast';

/**
 * Other people's music, and the two rules the ticket promoted from open questions to
 * requirements: **a mute that works** and **a cap with a stated winner**.
 *
 * Everything here is the phone's half. Nothing in it can prove that a broadcast is audible
 * in game — no iframe loads in this environment and CEF is not here — so what is under test
 * is the decision, not the sound: given a roster and a set of distances, which broadcasts
 * get a player, in what order, and what happens to one that loses its slot and later wins
 * it back.
 */

const VIDEO = 'dQw4w9WgXcQ';
const OTHER = 'M7lc1UVf-VE';
const PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

const START = 1_700_000_000_000;

/**
 * One roster row as the client hop delivers it.
 *
 * `source` is derived from the token rather than passed, because the two are joined here
 * and nowhere else: the roster carries both, and the volume map the game client sends is
 * keyed on `source` alone — a server id being the only handle it can measure a distance
 * to. Getting that join wrong is silent (everybody is at volume 0, so nothing plays), so
 * every fixture below exercises it.
 */
const SOURCES: Record<string, number> = { a: 11, b: 12, c: 13, d: 14, m: 15, z: 16, ok: 17 };
const sourceOf = (token: string): number => SOURCES[token] ?? 90;

const row = (token: string, over: Record<string, unknown> = {}) => ({
  source: sourceOf(token),
  token,
  label: null,
  videoId: VIDEO,
  playlistId: null,
  startedAt: START,
  paused: false,
  ...over
});

/** Volumes as the game client sends them: keyed by `source`, not by token. */
const volumes = (byToken: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(byToken).map(([token, v]) => [String(sourceOf(token)), v]));

/** Tokens, so an assertion reads as an order rather than a set. */
const audibleIds = () => get(audibleBroadcasts).map((b) => b.token);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  resetNearbyMusicForTest();
});

afterEach(() => {
  resetNearbyMusicForTest();
  vi.useRealTimers();
});

describe('the roster', () => {
  it('is a snapshot, so an empty one is how a broadcast ends', () => {
    receiveNearbyBroadcasts([row('a')]);
    receiveNearbyVolumes(volumes({ a: 0.9 }));
    expect(audibleIds()).toEqual(['a']);

    // Not a delta. A removal message that could be lost is music that never stops.
    receiveNearbyBroadcasts([]);
    expect(audibleIds()).toEqual([]);
    expect(get(nearbyBroadcastCount)).toBe(0);
  });

  it('drops a row with no token, nothing to play, or an id that is not a YouTube one', () => {
    receiveNearbyBroadcasts([
      row('ok'),
      row(''),
      { ...row('nosource'), videoId: null, playlistId: null },
      { ...row('badvideo'), videoId: 'not-an-id' },
      { ...row('badlist'), videoId: null, playlistId: 'nope' },
      'not an object',
      null
    ]);
    // Every id here ends up in an `<iframe src>`, so a row that fails the shape is dropped
    // rather than repaired. A row with no token is dropped too, and never falls back to the
    // server id — that fallback is a phone that plays perfectly and forgets every mute on
    // reconnect, which is mute evasion arriving as a feature.
    expect(get(nearbyBroadcasts).map((b) => b.token)).toEqual(['ok']);
  });

  it('lets the first mention of a token win, so one broadcaster cannot hold two slots', () => {
    receiveNearbyBroadcasts([row('a'), { ...row('a'), videoId: OTHER }]);
    expect(get(nearbyBroadcasts)).toHaveLength(1);
    expect(get(nearbyBroadcasts)[0].videoId).toBe(VIDEO);
  });

  it('joins the volume map to the roster by source, not by token', () => {
    receiveNearbyBroadcasts([row('a')]);
    // The two messages are keyed differently on purpose — the game client can only produce
    // a server id — and a phone that looked the volume up by token would find nothing,
    // treat everybody as out of earshot, and play silence with no error anywhere.
    receiveNearbyVolumes({ [String(sourceOf('a'))]: 0.7 });
    expect(get(audibleBroadcasts)[0]).toMatchObject({ token: 'a', attenuation: 0.7 });

    receiveNearbyVolumes({ a: 0.7 });
    expect(audibleIds()).toEqual([]);
  });

  it('bounds what one message can make the phone hold', () => {
    receiveNearbyBroadcasts(Array.from({ length: 40 }, (_, i) => row(`tok${i}`)));
    // A registered event is reachable regardless of what the server chose to send (§2.9).
    expect(get(nearbyBroadcasts).length).toBeLessThanOrEqual(16);
  });
});

describe('the cap', () => {
  const four = () => {
    receiveNearbyBroadcasts([row('a'), row('b'), row('c'), row('d')]);
    receiveNearbyVolumes(volumes({ a: 0.9, b: 0.8, c: 0.7, d: 0.6 }));
  };

  it('plays the nearest and no more than the cap', () => {
    four();
    expect(get(audibleBroadcasts)).toHaveLength(MAX_AUDIBLE_BROADCASTS);
    // Loudest first, and the volume is the distance inverted — the phone has no
    // coordinates and never learns any.
    expect(audibleIds()).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing or zero volume as out of earshot rather than as full volume', () => {
    receiveNearbyBroadcasts([row('a'), row('b')]);
    receiveNearbyVolumes(volumes({ a: 0 }));
    expect(audibleIds()).toEqual([]);

    receiveNearbyVolumes(volumes({ b: 0.5 }));
    expect(audibleIds()).toEqual(['b']);
  });

  it('breaks a tie by token rather than by the order the server happened to send', () => {
    receiveNearbyBroadcasts([row('z'), row('m'), row('a'), row('b')]);
    receiveNearbyVolumes(volumes({ z: 0.5, m: 0.5, a: 0.5, b: 0.5 }));
    expect(audibleIds()).toEqual(['a', 'b', 'm']);
  });

  it('holds an incumbent against jitter, and yields to a genuine overtake', () => {
    four();
    expect(audibleIds()).toEqual(['a', 'b', 'c']);

    // `d` edges past `c` by less than the margin. Two people walking near each other cross
    // and re-cross several times a second, and a slot change is an iframe destroyed and a
    // YouTube player created — so this must not move.
    receiveNearbyVolumes(volumes({ a: 0.9, b: 0.8, c: 0.7, d: 0.7 + INCUMBENT_MARGIN / 2 }));
    expect(audibleIds()).toEqual(['a', 'b', 'c']);

    // Genuinely closer, and it takes the slot.
    receiveNearbyVolumes(volumes({ a: 0.9, b: 0.8, c: 0.7, d: 0.7 + INCUMBENT_MARGIN * 2 }));
    expect(audibleIds()).toEqual(['a', 'b', 'd']);
  });

  it('re-admits an evicted broadcast as a fresh join, not where it left off', () => {
    four();
    receiveNearbyVolumes(volumes({ a: 0.9, b: 0.8, c: 0.7 }));
    expect(audibleIds()).not.toContain('d');

    // Ninety seconds later `d` is nearest again. It joins *live* — a broadcast is not a
    // thing you can resume, and replaying a stranger's past would be the only alternative.
    vi.setSystemTime(START + 90_000);
    receiveNearbyBroadcasts([row('a'), row('b'), row('c'), row('d', { startedAt: START })]);
    receiveNearbyVolumes(volumes({ a: 0.1, b: 0.1, c: 0.1, d: 0.9 }));

    const d = get(audibleBroadcasts).find((b) => b.token === 'd');
    expect(d?.startAt).toBe(90);
  });
});

describe('joining in progress', () => {
  it('starts a video where the broadcaster is', () => {
    vi.setSystemTime(START + 42_000);
    receiveNearbyBroadcasts([row('a', { startedAt: START })]);
    receiveNearbyVolumes(volumes({ a: 1 }));
    expect(get(audibleBroadcasts)[0].startAt).toBe(42);
  });

  it('does not offset a playlist, because startedAt names the list and not the track', () => {
    vi.setSystemTime(START + 42_000);
    receiveNearbyBroadcasts([row('a', { videoId: null, playlistId: PLAYLIST, startedAt: START })]);
    receiveNearbyVolumes(volumes({ a: 1 }));
    // Starting a playlist from the top is a visible desync and an honest one; seeking it to
    // `now - startedAt` would land in the middle of its *first* song.
    expect(get(audibleBroadcasts)[0].startAt).toBe(0);
  });

  it('holds the offset still while only the volume moves', () => {
    vi.setSystemTime(START + 10_000);
    receiveNearbyBroadcasts([row('a', { startedAt: START })]);
    receiveNearbyVolumes(volumes({ a: 0.9 }));
    expect(get(audibleBroadcasts)[0].startAt).toBe(10);

    // The offset is part of the embed URL and the frame is keyed on the URL, so a number
    // that moved with the clock would be a new YouTube player on every distance tick.
    vi.setSystemTime(START + 30_000);
    receiveNearbyVolumes(volumes({ a: 0.5 }));
    expect(get(audibleBroadcasts)[0].startAt).toBe(10);
  });

  it('re-joins when the broadcaster starts something else', () => {
    receiveNearbyBroadcasts([row('a', { startedAt: START })]);
    receiveNearbyVolumes(volumes({ a: 1 }));

    vi.setSystemTime(START + 60_000);
    receiveNearbyBroadcasts([row('a', { videoId: OTHER, startedAt: START + 55_000 })]);
    expect(get(audibleBroadcasts)[0].startAt).toBe(5);
  });

  it('clamps a start time from a clock that disagrees', () => {
    // A server clock a second ahead of the NUI's is ordinary; "start at the beginning" is
    // the right answer to it, rather than a negative `start` parameter.
    expect(joinOffsetSeconds(START + 5_000, START)).toBe(0);
    expect(joinOffsetSeconds(Number.NaN, START)).toBe(0);
    expect(joinOffsetSeconds(0, START)).toBe(24 * 60 * 60);
  });
});

describe('muting', () => {
  const three = () => {
    receiveNearbyBroadcasts([row('a'), row('b'), row('c')]);
    receiveNearbyVolumes(volumes({ a: 0.9, b: 0.8, c: 0.7 }));
  };

  it('silences one person and leaves everybody else alone', () => {
    three();
    muteBroadcaster('a');
    expect(audibleIds()).toEqual(['b', 'c']);
    expect(get(mutedBroadcasters)).toEqual(['a']);

    unmuteBroadcaster('a');
    expect(audibleIds()).toEqual(['a', 'b', 'c']);
  });

  it('does not let a muted broadcaster hold a slot of the cap', () => {
    receiveNearbyBroadcasts([row('a'), row('b'), row('c'), row('d')]);
    receiveNearbyVolumes(volumes({ a: 0.9, b: 0.8, c: 0.7, d: 0.6 }));
    muteBroadcaster('a');
    // Muting the nearest person is how you hear the next one, and that only works because
    // mute is applied before the ranking rather than after it. A mute that left a silent
    // hole would read as "mute broke the music" — one fewer stereo and no new one, which
    // is the opposite of what was asked for.
    expect(audibleIds()).toEqual(['b', 'c', 'd']);
  });

  /**
   * The other half of the same rule, and the one the hysteresis nearly broke.
   *
   * `INCUMBENT_MARGIN` gives whoever is already playing a ranking bonus, so that two
   * people walking near each other do not swap iframes several times a second. Applied to
   * an *unmute* it would mean somebody genuinely nearer losing to a 0.05 bonus — the
   * stated winner rule quietly not applying, which reads as the unmute not having worked.
   * A decision re-selects from scratch; only a distance tick keeps incumbency.
   */
  it('lets an unmuted broadcaster displace a further one that was already playing', () => {
    receiveNearbyBroadcasts([row('a'), row('b'), row('c'), row('d')]);
    receiveNearbyVolumes(volumes({ a: 0.9, b: 0.8, c: 0.7, d: 0.62 }));
    muteBroadcaster('a');
    expect(audibleIds()).toEqual(['b', 'c', 'd']);

    // `a` is nearest by a wide margin but was muted, so `d` inherited the third slot.
    // Unmuting has to take it back — and `d`'s incumbency must not be what decides it.
    unmuteBroadcaster('a');
    expect(audibleIds()).toEqual(['a', 'b', 'c']);
  });

  it('lets an arrival win a slot on the rule rather than on the margin', () => {
    receiveNearbyBroadcasts([row('b'), row('c'), row('d')]);
    receiveNearbyVolumes(volumes({ b: 0.8, c: 0.7, d: 0.62 }));
    expect(audibleIds()).toEqual(['b', 'c', 'd']);

    // Somebody walks up playing something, nearer than the third incumbent but by less
    // than the margin. A roster change is a discrete event, not distance jitter.
    receiveNearbyBroadcasts([row('a'), row('b'), row('c'), row('d')]);
    receiveNearbyVolumes(volumes({ a: 0.65, b: 0.8, c: 0.7, d: 0.62 }));
    expect(audibleIds()).toEqual(['b', 'c', 'a']);
  });

  it('silences everybody at once, whoever they are', () => {
    three();
    setMuteAllNearby(true);
    expect(audibleIds()).toEqual([]);
    expect(get(muteAllNearby)).toBe(true);

    // Still listed, deliberately: the row is the only way back, and a person who has
    // forgotten they threw the switch needs to see it at the moment music is being played
    // near them.
    expect(get(nearbyBroadcastCount)).toBe(3);

    setMuteAllNearby(false);
    expect(audibleIds()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the global switch independent of the individual list', () => {
    three();
    muteBroadcaster('b');
    setMuteAllNearby(true);
    setMuteAllNearby(false);
    // The global mute is a standing statement about everybody, not a bulk edit of the list.
    expect(get(mutedBroadcasters)).toEqual(['b']);
    expect(audibleIds()).toEqual(['a', 'c']);

    clearMutedBroadcasters();
    expect(audibleIds()).toEqual(['a', 'b', 'c']);
  });

  it('outlives the broadcaster walking away and coming back', () => {
    three();
    muteBroadcaster('a');

    receiveNearbyBroadcasts([]);
    receiveNearbyBroadcasts([row('a')]);
    receiveNearbyVolumes(volumes({ a: 0.9 }));
    // The key is a token the server issues per character, not a connection — so leaving
    // range, or the game, is not a way out of somebody's mute list.
    expect(audibleIds()).toEqual([]);
  });

  it('toggles', () => {
    three();
    toggleBroadcasterMute('c');
    expect(get(mutedBroadcasters)).toEqual(['c']);
    toggleBroadcasterMute('c');
    expect(get(mutedBroadcasters)).toEqual([]);
  });

  it('ignores an empty id rather than storing one nothing can match', () => {
    muteBroadcaster('');
    expect(get(mutedBroadcasters)).toEqual([]);
  });
});

describe('what the players are told', () => {
  it('carries the attenuation the game client pushed, unbonused', () => {
    receiveNearbyBroadcasts([row('a'), row('b')]);
    receiveNearbyVolumes(volumes({ a: 0.4, b: 0.3 }));
    // The incumbent margin is a *ranking* bonus. A broadcast must not get louder for having
    // been audible a moment ago.
    receiveNearbyVolumes(volumes({ a: 0.4, b: 0.3 }));
    expect(get(audibleBroadcasts).map((b) => b.attenuation)).toEqual([0.4, 0.3]);
  });

  it('clamps a volume from outside the phone into 0..1', () => {
    receiveNearbyBroadcasts([row('a'), row('b')]);
    receiveNearbyVolumes(volumes({ a: 12, b: -3 }));
    expect(get(audibleBroadcasts)).toHaveLength(1);
    expect(get(audibleBroadcasts)[0]).toMatchObject({ token: 'a', attenuation: 1 });
  });

  it('leaves the store alone when a volume tick changes nothing audible', () => {
    receiveNearbyBroadcasts([row('a')]);
    receiveNearbyVolumes(volumes({ a: 0.5 }));

    let writes = 0;
    const stop = audibleBroadcasts.subscribe(() => (writes += 1));
    receiveNearbyVolumes(volumes({ a: 0.5 }));
    receiveNearbyVolumes(volumes({ a: 0.5 }));
    stop();
    // One for the subscription itself, and none for the two identical ticks: every write
    // here is an `{#each}` re-render over cross-origin video players.
    expect(writes).toBe(1);
  });

  it('passes a pause through without tearing the player down', () => {
    receiveNearbyBroadcasts([row('a')]);
    receiveNearbyVolumes(volumes({ a: 0.5 }));
    receiveNearbyBroadcasts([row('a', { paused: true })]);

    // Still audible-listed, so the frame survives: they are standing there and are about to
    // press play again, and rebuilding for a five-second pause is a reload for everybody.
    expect(audibleIds()).toEqual(['a']);
    expect(get(audibleBroadcasts)[0].paused).toBe(true);
  });

  it('bounds a label chosen outside the phone', () => {
    receiveNearbyBroadcasts([
      row('a', { label: `  ${'x'.repeat(200)}  ` }),
      row('b', { label: 7 })
    ]);
    expect(get(nearbyBroadcasts)[0].label).toHaveLength(48);
    expect(get(nearbyBroadcasts)[1].label).toBeNull();
  });
});

describe('the global mute survives a restart and the per-person list is bounded', () => {
  it('sanitises a stored mute list', async () => {
    // A fresh module graph, which is what a resource restart produces — the same trick
    // `music.test.ts` uses. Its `restart` helper carries the full explanation of why
    // `facets/storage` is imported alone before the seed and the whole set only after
    // (importing the set evaluates `shell/state/nearbyMusic.ts`, the module under test),
    // and why the module-scope `Map` still backs storage under jsdom.
    vi.resetModules();
    await import('../../sdk/host/inProcess/facets/storage');
    const { useStorage } = await import('../../sdk/host/useStorage');
    const storage = useStorage('settings');
    storage.setItem('musicMutedBroadcasters', ['a', 'a', '', 7, 'b']);
    storage.setItem('musicMuteNearby', true);

    await import('../../sdk/host/inProcess/registerFacets');
    const mod = await import('./nearbyMusic');
    expect(get(mod.mutedBroadcasters)).toEqual(['a', 'b']);
    expect(get(mod.muteAllNearby)).toBe(true);
  });
});
