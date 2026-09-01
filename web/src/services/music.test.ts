// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import '../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../nui/fetchNui', () => ({ fetchNui: vi.fn(async () => ({ ok: true })) }));

import { fetchNui as rawFetchNui } from '../nui/fetchNui';
import {
  nextTrack,
  pauseMusic,
  playSource,
  reportPlayerError,
  reportPlayerState,
  resetMusicForTest,
  resumeMusic,
  seekMusic,
  reportPlayerProgress,
  stopMusic,
  enqueue
} from '../shell/state/music';
import { installMusicBroadcast, resetMusicBroadcastForTest } from './music';

const fetchNui = vi.mocked(rawFetchNui);

/**
 * Telling the server what this phone is playing out loud. MICA-111 phase 2.
 *
 * The half of proximity audio that fails invisibly: nothing on this phone sounds any
 * different when the announce is wrong, because your own music comes out of your own
 * player either way. What breaks is other people's experience of you — a track everybody
 * nearby keeps hearing after you stopped it, a pause they never get, a position that
 * drifts further apart the longer the song runs.
 *
 * So what is asserted here is what the server was *told*, and — as much as anything — what
 * it was not told twice. Every redundant announce is a net event and a fan-out to
 * everybody in range.
 */

const VIDEO = 'dQw4w9WgXcQ';
const OTHER = 'M7lc1UVf-VE';

/** Announces only, in order, with the payloads. */
const sent = () =>
  fetchNui.mock.calls.map(
    (call) => [call[0], call[1]] as [string, Record<string, unknown> | undefined]
  );

const actions = () => sent().map(([action]) => action);

/**
 * Let the coalescing microtask run.
 *
 * `services/music.ts` batches a tick's store writes into one announce, because `goTo`
 * writes five stores in sequence and announcing from each saw a half-applied state — see
 * `schedule` there. Two turns, so the assertion is never racing the queue it is waiting on.
 */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(async () => {
  resetMusicForTest();
  resetMusicBroadcastForTest();
  fetchNui.mockClear();
  installMusicBroadcast();
  // Subscribing schedules one pass against an idle phone, which announces nothing.
  await flush();
  fetchNui.mockClear();
});

describe('announcing what this phone is playing', () => {
  it('says nothing at all while nothing is playing', async () => {
    await flush();
    expect(actions()).toEqual([]);
  });

  it('announces a track, once, however many states it passes through', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    await flush();

    expect(actions()).toEqual(['startMusicBroadcast']);
    expect(sent()[0][1]).toMatchObject({ videoId: VIDEO, playlistId: null, positionMs: 0 });

    // `loading` becoming `playing` is the same track still playing, and a position report
    // is not news to anybody — both would otherwise be a net event and a fan-out to
    // everybody in range, several times a track.
    fetchNui.mockClear();
    reportPlayerState('playing');
    reportPlayerProgress({ currentTime: 12, duration: 200 });
    await flush();
    expect(actions()).toEqual([]);
  });

  it('replaces rather than stacking when the queue advances', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    enqueue(`https://youtu.be/${OTHER}`);
    await flush();
    fetchNui.mockClear();

    nextTrack();
    await flush();
    // A queue advancing is a track change and the server treats a second start as a
    // replacement, so there is deliberately no stop-then-start pair here.
    expect(actions()).toEqual(['startMusicBroadcast']);
    expect(sent()[0][1]).toMatchObject({ videoId: OTHER });
  });

  it('passes a pause and a resume through, with where the track actually is', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    reportPlayerState('playing');
    reportPlayerProgress({ currentTime: 30, duration: 200 });
    await flush();
    fetchNui.mockClear();

    pauseMusic();
    await flush();
    expect(sent()).toEqual([['updateMusicBroadcast', { paused: true, positionMs: 30_000 }]]);

    fetchNui.mockClear();
    resumeMusic();
    await flush();
    expect(sent()).toEqual([['updateMusicBroadcast', { paused: false, positionMs: 30_000 }]]);
  });

  it('does not repeat a pause it has already announced', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    await flush();
    pauseMusic();
    await flush();
    fetchNui.mockClear();

    pauseMusic();
    pauseMusic();
    await flush();
    expect(actions()).toEqual([]);
  });

  /**
   * The one neither `musicSource` nor `musicStatus` expresses. Scrubbing leaves both
   * exactly as they were — that is the whole reason `MusicSeek` is a token — so without
   * its own subscription, moving the playhead would desynchronise every listener until the
   * next track.
   */
  it('announces a seek, which nothing else would have said', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    reportPlayerProgress({ currentTime: 10, duration: 200 });
    await flush();
    fetchNui.mockClear();

    seekMusic(90);
    await flush();
    expect(sent()).toEqual([['updateMusicBroadcast', { positionMs: 90_000 }]]);
  });

  it('does not carry a seek across into the track that replaced it', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    reportPlayerProgress({ currentTime: 10, duration: 200 });
    seekMusic(90);
    enqueue(`https://youtu.be/${OTHER}`);
    await flush();
    fetchNui.mockClear();

    nextTrack();
    await flush();
    // A seek issued against the track being replaced is not a seek in the new one, and the
    // new one starts at the top.
    expect(actions()).toEqual(['startMusicBroadcast']);
  });

  it('stops when the music stops', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    await flush();
    fetchNui.mockClear();

    stopMusic();
    await flush();
    expect(actions()).toEqual(['stopMusicBroadcast']);

    // Idempotent from here: nothing is playing and nothing more needs saying.
    fetchNui.mockClear();
    stopMusic();
    await flush();
    expect(actions()).toEqual([]);
  });

  /**
   * A refused track is not a quiet one from the neighbours' point of view — it would be a
   * broadcast of silence, and worse, one holding a slot of everybody's cap against
   * somebody they could actually hear.
   */
  it('stops broadcasting a track the player has refused', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    await flush();
    fetchNui.mockClear();

    reportPlayerError(150);
    await flush();
    expect(actions()).toEqual(['stopMusicBroadcast']);
  });

  it('never sends a volume or a mute, in either direction', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    await flush();
    pauseMusic();
    await flush();
    seekMusic(5);
    await flush();

    // How loud your music is on somebody else's phone is their distance and their setting.
    // A mute is theirs too, and the broadcaster is never told about it.
    const keys = sent().flatMap(([, payload]) => Object.keys(payload ?? {}));
    expect(keys).not.toContain('volume');
    expect(keys).not.toContain('muted');
  });
});
