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
import '../../host/registerFacets';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { callStore } from '../../services/call';
import {
  YOUTUBE_EMBED_ORIGIN,
  clearQueue,
  cycleRepeat,
  embedUrlFor,
  enqueue,
  musicError,
  musicIndex,
  musicNowPlaying,
  musicOutputVolume,
  musicPosition,
  musicQueue,
  musicRepeat,
  musicSeek,
  musicShuffle,
  musicSource,
  musicStatus,
  musicMuted,
  setMusicMuted,
  setMusicVolume,
  toggleMusicMute,
  nextTrack,
  pauseMusic,
  playQueueIndex,
  playSource,
  playerCommand,
  previousTrack,
  removeFromQueue,
  musicVolume,
  reportNowPlaying,
  reportPlayerError,
  reportPlayerProgress,
  reportPlayerState,
  resetMusicForTest,
  resumeMusic,
  seekMusic,
  setRepeat,
  stopMusic,
  toggleShuffle
} from './music';

/**
 * MICA-111 phases 1 and 3. What these can and cannot prove is worth saying up front:
 * this is jsdom, so nothing here exercises the embed, CEF, or the autoplay policy — the
 * three things phase 1 exists to answer, and none of them are settled by a green suite.
 * What it does hold down is everything the phone decides for itself: the only thing ever
 * interpolated into the frame's `src` is a validated id and the origin is a constant
 * (a *security* bug rather than a "does not work" bug), and the queue moves the way the
 * buttons say it does.
 *
 * `reportPlayerState` and `reportNowPlaying` stand in for the player here. That is the
 * honest shape of the seam — in the page they are called from `MusicPlayer.svelte`'s
 * `message` handler and nowhere else — but it does mean these tests prove what the phone
 * does *with* what the player says, never that the player says it.
 */

beforeEach(() => {
  resetMusicForTest();
  callStore.setStatus('idle');
  musicVolume.set(0.5);
});

const VIDEO = 'dQw4w9WgXcQ';
const PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

/** Three distinct, valid video ids, so a queue is a queue and not one track three times. */
const [A, B, C] = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];

const ids = () => get(musicQueue).map((entry) => entry.videoId);
const keyAt = (index: number) => get(musicQueue)[index].key;

/** Queue three tracks and start the first, which is the state most of these begin from. */
const queueThree = () => {
  enqueue(A);
  enqueue(B);
  enqueue(C);
  playQueueIndex(0);
};

describe('playSource', () => {
  it('keeps the ids and starts loading', () => {
    playSource(`https://youtu.be/${VIDEO}`);
    expect(get(musicSource)).toEqual({ videoId: VIDEO, playlistId: null });
    expect(get(musicStatus)).toBe('loading');
  });

  it('drops anything that is not a YouTube source, and changes nothing', () => {
    playSource('https://example.com/track.mp3');
    expect(get(musicSource)).toBeNull();
    expect(get(musicStatus)).toBe('idle');
  });

  it('leaves a playing track alone when the next paste is junk', () => {
    playSource(`https://youtu.be/${VIDEO}`);
    playSource('nonsense');
    expect(get(musicSource)).toEqual({ videoId: VIDEO, playlistId: null });
    expect(get(musicStatus)).toBe('loading');
  });
});

describe('transport', () => {
  it('pauses and resumes a loaded track', () => {
    playSource(VIDEO);
    pauseMusic();
    expect(get(musicStatus)).toBe('paused');
    resumeMusic();
    expect(get(musicStatus)).toBe('playing');
  });

  it('does nothing when there is nothing loaded', () => {
    resumeMusic();
    expect(get(musicStatus)).toBe('idle');
    pauseMusic();
    expect(get(musicStatus)).toBe('idle');
  });

  it('stop unloads, so the shell can tear the frame down', () => {
    playSource(VIDEO);
    stopMusic();
    expect(get(musicSource)).toBeNull();
    expect(get(musicStatus)).toBe('idle');
  });
});

describe('reportPlayerState', () => {
  it('promotes loading to playing once the embed says it started', () => {
    playSource(VIDEO);
    reportPlayerState('playing');
    expect(get(musicStatus)).toBe('playing');
  });

  it('unloads when the track ends', () => {
    playSource(VIDEO);
    reportPlayerState('ended');
    expect(get(musicSource)).toBeNull();
    expect(get(musicStatus)).toBe('idle');
  });

  it('does not undo a pause the person just asked for', () => {
    // The embed's own `paused`/`playing` reports race the command that caused them; only
    // `ended` is news the phone could not already know.
    playSource(VIDEO);
    pauseMusic();
    reportPlayerState('playing');
    expect(get(musicStatus)).toBe('paused');
  });

  it('ignores a report arriving after everything was stopped', () => {
    reportPlayerState('ended');
    expect(get(musicStatus)).toBe('idle');
  });
});

describe('embedUrlFor', () => {
  it('builds a nocookie embed from a video id', () => {
    const url = embedUrlFor({ videoId: VIDEO, playlistId: null });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe(YOUTUBE_EMBED_ORIGIN);
    expect(parsed.pathname).toBe(`/embed/${VIDEO}`);
    expect(parsed.searchParams.get('enablejsapi')).toBe('1');
    expect(parsed.searchParams.get('autoplay')).toBe('1');
    expect(parsed.searchParams.get('origin')).toBeNull();
  });

  it('uses videoseries for a playlist with no entry video', () => {
    const parsed = new URL(embedUrlFor({ videoId: null, playlistId: PLAYLIST })!);
    expect(parsed.pathname).toBe('/embed/videoseries');
    expect(parsed.searchParams.get('list')).toBe(PLAYLIST);
    expect(parsed.searchParams.get('listType')).toBe('playlist');
  });

  it('names an http(s) origin and refuses anything else', () => {
    expect(
      new URL(
        embedUrlFor({ videoId: VIDEO, playlistId: null }, 'https://cfx-nui-gphone')!
      ).searchParams.get('origin')
    ).toBe('https://cfx-nui-gphone');
    expect(
      new URL(embedUrlFor({ videoId: VIDEO, playlistId: null }, 'nui://game')!).searchParams.get(
        'origin'
      )
    ).toBeNull();
  });

  it('carries a start offset only when one is asked for, and only a sane one', () => {
    // How a remote broadcast joins in progress (MICA-111 phase 2). A URL parameter
    // rather than a `seekTo` after load, because a seek races the autoplay it is
    // correcting and the audible failure is the first seconds playing before the jump.
    const at = (start: unknown) =>
      new URL(
        embedUrlFor({ videoId: VIDEO, playlistId: null }, undefined, {
          start: start as number
        })!
      ).searchParams.get('start');

    expect(at(90)).toBe('90');
    expect(at(90.7)).toBe('90');
    // The phone's own playback passes none, and starts where it was told to.
    expect(
      new URL(embedUrlFor({ videoId: VIDEO, playlistId: null })!).searchParams.get('start')
    ).toBeNull();
    // Dropped rather than coerced: `start=NaN` is a parameter YouTube may interpret
    // however it likes.
    expect(at(0)).toBeNull();
    expect(at(-5)).toBeNull();
    expect(at(Number.NaN)).toBeNull();
    expect(at('60')).toBeNull();
  });

  it('re-validates the ids rather than trusting the caller', () => {
    // The store cannot hold these — `playSource` would have refused them — which is the
    // point: this function does not depend on that having happened.
    expect(embedUrlFor({ videoId: '../../evil', playlistId: null })).toBeNull();
    expect(embedUrlFor({ videoId: null, playlistId: 'a"onload=x' })).toBeNull();
    expect(embedUrlFor({ videoId: null, playlistId: null })).toBeNull();
  });
});

describe('playerCommand', () => {
  it('is the IFrame API wire format, built rather than concatenated', () => {
    expect(JSON.parse(playerCommand('setVolume', [50]))).toEqual({
      event: 'command',
      func: 'setVolume',
      args: [50]
    });
    expect(JSON.parse(playerCommand('playVideo'))).toEqual({
      event: 'command',
      func: 'playVideo',
      args: []
    });
  });
});

describe('the queue', () => {
  it('queues without interrupting, and without starting', () => {
    enqueue(A);
    enqueue(B);
    expect(ids()).toEqual([A, B]);
    // Deliberate: a button labelled "Queue" that begins playing is the wrong button.
    expect(get(musicStatus)).toBe('idle');
    expect(get(musicSource)).toBeNull();
  });

  it('plays a paste after the current row rather than behind the whole queue', () => {
    queueThree();
    playSource(VIDEO);
    expect(ids()).toEqual([A, VIDEO, B, C]);
    expect(get(musicIndex)).toBe(1);
    // The rest of the queue is still in front of it, which is the point of inserting.
    nextTrack();
    expect(get(musicSource)).toEqual({ videoId: B, playlistId: null });
  });

  it('walks forward and stops at the end when nothing repeats', () => {
    queueThree();
    nextTrack();
    expect(get(musicIndex)).toBe(1);
    nextTrack();
    expect(get(musicIndex)).toBe(2);
    nextTrack();
    expect(get(musicSource)).toBeNull();
    expect(get(musicStatus)).toBe('idle');
    // Stop is not clear: what was lined up survives it.
    expect(ids()).toEqual([A, B, C]);
  });

  it('starts the queue when play is pressed with nothing loaded', () => {
    queueThree();
    stopMusic();
    resumeMusic();
    expect(get(musicIndex)).toBe(0);
    expect(get(musicStatus)).toBe('loading');
  });

  it('steps back through what actually played', () => {
    queueThree();
    nextTrack();
    nextTrack();
    previousTrack();
    expect(get(musicIndex)).toBe(1);
    previousTrack();
    expect(get(musicIndex)).toBe(0);
  });

  it('restarts the first track rather than falling off the front', () => {
    queueThree();
    const before = get(musicSeek)?.token ?? 0;
    previousTrack();
    expect(get(musicIndex)).toBe(0);
    // Nothing to go back to, so the phone asks the embed to seek instead — the URL is
    // unchanged, so a seek is the only signal that can reach the frame.
    expect(get(musicSeek)).toEqual({ token: before + 1, seconds: 0, resume: true });
  });

  it('falls through to the next row when the row playing is removed', () => {
    queueThree();
    removeFromQueue(keyAt(0));
    expect(ids()).toEqual([B, C]);
    expect(get(musicSource)).toEqual({ videoId: B, playlistId: null });
  });

  it('keeps playing the same row when a row above it is removed', () => {
    queueThree();
    nextTrack();
    removeFromQueue(keyAt(0));
    expect(get(musicIndex)).toBe(0);
    expect(get(musicSource)).toEqual({ videoId: B, playlistId: null });
  });

  it('does not start playing because something was deleted', () => {
    enqueue(A);
    enqueue(B);
    removeFromQueue(keyAt(0));
    expect(get(musicStatus)).toBe('idle');
    expect(get(musicSource)).toBeNull();
  });

  it('stops when the last row is removed', () => {
    playSource(A);
    removeFromQueue(keyAt(0));
    expect(ids()).toEqual([]);
    expect(get(musicStatus)).toBe('idle');
  });

  it('clears everything', () => {
    queueThree();
    clearQueue();
    expect(ids()).toEqual([]);
    expect(get(musicSource)).toBeNull();
    expect(get(musicStatus)).toBe('idle');
  });

  it('treats the same track queued twice as two rows', () => {
    enqueue(A);
    enqueue(A);
    const [first, second] = get(musicQueue);
    expect(first.key).not.toBe(second.key);
    removeFromQueue(first.key);
    expect(ids()).toEqual([A]);
  });

  it('asks for a restart when the next row is the same track', () => {
    enqueue(A);
    enqueue(A);
    playQueueIndex(0);
    const before = get(musicSeek)?.token ?? 0;
    nextTrack();
    // The embed URL does not change between two rows holding one video, so nothing in
    // `MusicPlayer.svelte` would fire without this.
    expect(get(musicIndex)).toBe(1);
    expect(get(musicSeek)?.token).toBe(before + 1);
  });
});

describe('repeat', () => {
  it('cycles off, all, one', () => {
    expect(get(musicRepeat)).toBe('off');
    cycleRepeat();
    expect(get(musicRepeat)).toBe('all');
    cycleRepeat();
    expect(get(musicRepeat)).toBe('one');
    cycleRepeat();
    expect(get(musicRepeat)).toBe('off');
  });

  it('wraps to the top of the queue on all', () => {
    queueThree();
    setRepeat('all');
    nextTrack();
    nextTrack();
    nextTrack();
    expect(get(musicIndex)).toBe(0);
    expect(get(musicSource)).toEqual({ videoId: A, playlistId: null });
  });

  it('replays the same track on one, without moving the queue', () => {
    queueThree();
    setRepeat('one');
    const before = get(musicSeek)?.token ?? 0;
    reportPlayerState('ended');
    expect(get(musicIndex)).toBe(0);
    expect(get(musicSeek)).toEqual({ token: before + 1, seconds: 0, resume: true });
  });

  it('does not repeat one when the person presses next', () => {
    // "Next" means next, whatever the repeat mode says about what happens on its own.
    queueThree();
    setRepeat('one');
    nextTrack();
    expect(get(musicIndex)).toBe(1);
  });
});

describe('shuffle', () => {
  it('plays every row once before repeating any of them', () => {
    enqueue(A);
    enqueue(B);
    enqueue(C);
    toggleShuffle();
    expect(get(musicShuffle)).toBe(true);
    playQueueIndex(0);

    const played = [get(musicIndex)];
    nextTrack();
    played.push(get(musicIndex));
    nextTrack();
    played.push(get(musicIndex));
    expect([...played].sort()).toEqual([0, 1, 2]);

    // A cycle, not a die roll: with nothing unplayed left and no repeat, it ends.
    nextTrack();
    expect(get(musicSource)).toBeNull();
  });

  it('starts a fresh cycle under repeat all', () => {
    enqueue(A);
    enqueue(B);
    toggleShuffle();
    setRepeat('all');
    playQueueIndex(0);
    nextTrack();
    nextTrack();
    expect(get(musicIndex)).toBeGreaterThanOrEqual(0);
    expect(get(musicStatus)).toBe('loading');
  });

  it('goes back to what played, not to the row above', () => {
    enqueue(A);
    enqueue(B);
    enqueue(C);
    toggleShuffle();
    playQueueIndex(2);
    nextTrack();
    const second = get(musicIndex);
    previousTrack();
    expect(get(musicIndex)).toBe(2);
    expect(second).not.toBe(2);
  });
});

describe('a playlist row', () => {
  /**
   * The decision this pins down: a playlist is handed to the embed whole, so it is **one**
   * queue row that advances inside itself. The phone cannot enumerate a playlist's videos
   * without a network call it does not make, so an `ended` between two of them must not be
   * read as "this row finished".
   */
  it('does not advance the queue while the embed is still inside the playlist', () => {
    enqueue(`https://www.youtube.com/playlist?list=${PLAYLIST}`);
    enqueue(A);
    playQueueIndex(0);
    reportNowPlaying({ playlistIndex: 0, playlistCount: 12, videoId: B, title: 'Track one' });
    reportPlayerState('ended');
    expect(get(musicIndex)).toBe(0);
    expect(get(musicSource)).toEqual({ videoId: null, playlistId: PLAYLIST });
  });

  it('advances once the embed reports the last entry', () => {
    enqueue(`https://www.youtube.com/playlist?list=${PLAYLIST}`);
    enqueue(A);
    playQueueIndex(0);
    reportNowPlaying({ playlistIndex: 11, playlistCount: 12 });
    reportPlayerState('ended');
    expect(get(musicSource)).toEqual({ videoId: A, playlistId: null });
  });

  it('holds rather than skipping when the player says nothing about the position', () => {
    // A queue that stalls at the end of a playlist is one button press from moving on. One
    // that skipped the other 39 tracks is silently broken, so the unknown case holds.
    enqueue(`https://www.youtube.com/playlist?list=${PLAYLIST}`);
    enqueue(A);
    playQueueIndex(0);
    reportPlayerState('ended');
    expect(get(musicIndex)).toBe(0);
  });
});

describe('reportNowPlaying', () => {
  it('names the track from what the player says, and gives the row its title', () => {
    playSource(A);
    reportNowPlaying({ title: 'Never Gonna Give You Up', videoId: A });
    expect(get(musicNowPlaying)?.title).toBe('Never Gonna Give You Up');
    expect(get(musicQueue)[0].title).toBe('Never Gonna Give You Up');
  });

  it('merges across messages, since the player does not send every field every time', () => {
    playSource(A);
    reportNowPlaying({ title: 'Track', videoId: A });
    reportNowPlaying({ playlistIndex: 0, playlistCount: 3 });
    expect(get(musicNowPlaying)).toEqual({
      title: 'Track',
      videoId: A,
      playlistIndex: 0,
      playlistCount: 3
    });
  });

  it('forgets what it knew when the track changes', () => {
    queueThree();
    reportNowPlaying({ title: 'First', videoId: A });
    nextTrack();
    expect(get(musicNowPlaying)).toBeNull();
    // The row that earned the title keeps it; the new one has none yet.
    expect(get(musicQueue)[0].title).toBe('First');
    expect(get(musicQueue)[1].title).toBeNull();
  });

  it('does not write a playlist row’s label from whatever is playing inside it', () => {
    enqueue(`https://www.youtube.com/playlist?list=${PLAYLIST}`);
    playQueueIndex(0);
    reportNowPlaying({ title: 'Song 4', videoId: B });
    expect(get(musicNowPlaying)?.title).toBe('Song 4');
    expect(get(musicQueue)[0].title).toBeNull();
  });

  it('bounds and cleans a title, which a cross-origin document chose', () => {
    playSource(A);
    reportNowPlaying({ title: `  a\nb\tc  `, videoId: A });
    expect(get(musicQueue)[0].title).toBe('a b c');

    reportNowPlaying({ title: 'x'.repeat(400), videoId: A });
    const title = get(musicQueue)[0].title ?? '';
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('…')).toBe(true);
  });

  it('refuses a field that is not the shape it claims', () => {
    playSource(A);
    reportNowPlaying({ title: { toString: () => 'nope' }, videoId: 'javascript:alert(1)' });
    expect(get(musicNowPlaying)).toBeNull();
    expect(get(musicQueue)[0].title).toBeNull();
  });

  it('ignores a report arriving with nothing loaded', () => {
    reportNowPlaying({ title: 'Ghost', videoId: A });
    expect(get(musicNowPlaying)).toBeNull();
  });
});

describe('reportPlayerError', () => {
  /**
   * The failure this exists for is not exotic: a video whose uploader disabled embedding
   * is a large fraction of the actual music on YouTube, and without this the phone sits on
   * `Starting…` forever. That hang is also indistinguishable from CEF refusing the frame,
   * which is the one thing phase 1's in-game procedure is trying to find out — so an
   * unhandled error does not just annoy a player, it corrupts the test.
   */
  it.each([
    [101, 'embed-blocked'],
    [150, 'embed-blocked'],
    [100, 'unavailable'],
    [2, 'unplayable'],
    [5, 'unplayable'],
    [999, 'unplayable']
  ])('maps code %i to %s', (code, reason) => {
    playSource(A);
    reportPlayerError(code);
    expect(get(musicError)).toEqual({ reason, code });
    expect(get(musicStatus)).toBe('error');
  });

  it('keeps the failure on the row, so the list still says which track is bad', () => {
    queueThree();
    reportPlayerError(150);
    nextTrack();
    expect(get(musicQueue)[0].error).toEqual({ reason: 'embed-blocked', code: 150 });
    // Moving on clears the phone's state but not the row's record of why.
    expect(get(musicError)).toBeNull();
    expect(get(musicStatus)).toBe('loading');
  });

  it('does not let a later report bury the failure', () => {
    // The player may well say `ended` after refusing a video. Acting on it would advance
    // the queue — or, on a one-track queue, stop and clear the message — and the reason
    // would vanish before anybody read it.
    playSource(A);
    reportPlayerError(101);
    reportPlayerState('ended');
    expect(get(musicStatus)).toBe('error');
    expect(get(musicError)?.reason).toBe('embed-blocked');
    expect(get(musicSource)).toEqual({ videoId: A, playlistId: null });
  });

  it('offers nothing to press on a track the player refused', () => {
    playSource(A);
    reportPlayerError(101);
    resumeMusic();
    expect(get(musicStatus)).toBe('error');
    pauseMusic();
    expect(get(musicStatus)).toBe('error');
  });

  it('skipping past it clears the phone state', () => {
    queueThree();
    reportPlayerError(100);
    nextTrack();
    expect(get(musicError)).toBeNull();
    expect(get(musicSource)).toEqual({ videoId: B, playlistId: null });
  });

  it('ignores a code that is not one, and a report with nothing loaded', () => {
    playSource(A);
    reportPlayerError('101');
    reportPlayerError(Number.NaN);
    expect(get(musicError)).toBeNull();
    expect(get(musicStatus)).toBe('loading');

    stopMusic();
    reportPlayerError(101);
    expect(get(musicError)).toBeNull();
  });
});

describe('position and seeking', () => {
  it('takes the position from the player, since nothing can ask for it', () => {
    playSource(A);
    reportPlayerProgress({ currentTime: 42.5, duration: 210 });
    expect(get(musicPosition)).toEqual({ current: 42.5, duration: 210 });
  });

  it('keeps a duration reported once, through reports that omit it', () => {
    playSource(A);
    reportPlayerProgress({ currentTime: 1, duration: 210 });
    reportPlayerProgress({ currentTime: 2 });
    expect(get(musicPosition)).toEqual({ current: 2, duration: 210 });
  });

  it('refuses a position that is not a number', () => {
    playSource(A);
    reportPlayerProgress({ currentTime: '30', duration: Number.NaN });
    expect(get(musicPosition)).toEqual({ current: 0, duration: 0 });
  });

  it('asks the frame to move, and moves the readout with it', () => {
    playSource(A);
    reportPlayerProgress({ currentTime: 0, duration: 200 });
    const before = get(musicSeek)?.token ?? 0;
    seekMusic(90);
    // `resume: false` — a scrub leaves a paused track paused where it was put.
    expect(get(musicSeek)).toEqual({ token: before + 1, seconds: 90, resume: false });
    // Optimistic, so the control does not snap back while the player catches up.
    expect(get(musicPosition).current).toBe(90);
  });

  it('cannot be seeked past the end, or below the start', () => {
    playSource(A);
    reportPlayerProgress({ currentTime: 0, duration: 200 });
    seekMusic(9999);
    expect(get(musicPosition).current).toBe(200);
    seekMusic(-5);
    expect(get(musicPosition).current).toBe(0);
  });

  it('forgets the position when the track changes', () => {
    queueThree();
    reportPlayerProgress({ currentTime: 100, duration: 200 });
    nextTrack();
    expect(get(musicPosition)).toEqual({ current: 0, duration: 0 });
  });
});

describe('a call', () => {
  /**
   * MICA-63 shipped calls that break through Do Not Disturb because a missed call is the
   * failure worth preventing. Music playing over the ringtone undoes that, and music over
   * a connected call on speakerphone is worse than a missed one.
   */
  it('ducks under a ringing phone without touching the setting', () => {
    playSource(A);
    callStore.setIncoming('5550101');
    expect(get(musicOutputVolume)).toBeCloseTo(0.1);
    // The persisted preference is untouched — a duck that wrote to it would leave somebody
    // permanently at a fifth if the un-duck were ever missed.
    expect(get(musicVolume)).toBe(0.5);
    expect(get(musicStatus)).toBe('loading');

    callStore.setStatus('idle');
    expect(get(musicOutputVolume)).toBe(0.5);
  });

  it("ducks a connected call too, which is only audible on somebody else's music", () => {
    // Your own track is *paused* on a connected call, so this changes nothing you can
    // hear from this phone — but `musicOutputVolume` is also what nearby broadcasts play
    // at (`NearbyMusicFrame.svelte`), and a stranger's music at full volume under a
    // conversation is the failure this whole block exists to prevent. Ducked rather than
    // silenced because it is the world's sound: a bar does not go quiet because you took
    // a call in it.
    playSource(A);
    callStore.setStatus('connected');
    expect(get(musicOutputVolume)).toBeCloseTo(0.1);

    callStore.setStatus('idle');
    expect(get(musicOutputVolume)).toBe(0.5);
  });

  it('pauses for a connected call and brings it back', () => {
    playSource(A);
    reportPlayerState('playing');
    callStore.setIncoming('5550101');
    callStore.setStatus('connected');
    expect(get(musicStatus)).toBe('paused');

    callStore.setStatus('idle');
    expect(get(musicStatus)).toBe('playing');
    expect(get(musicOutputVolume)).toBe(0.5);
  });

  it('does not resume a pause the person asked for', () => {
    playSource(A);
    reportPlayerState('playing');
    callStore.setStatus('connected');
    callStore.setStatus('idle');
    expect(get(musicStatus)).toBe('playing');

    // Their own pause, during the next call, is theirs to undo.
    callStore.setStatus('connected');
    callStore.setStatus('idle');
    pauseMusic();
    callStore.setIncoming('5550101');
    callStore.setStatus('connected');
    callStore.setStatus('idle');
    expect(get(musicStatus)).toBe('paused');
  });

  it('does not start music that was not playing when the call came in', () => {
    queueThree();
    stopMusic();
    callStore.setStatus('connected');
    callStore.setStatus('idle');
    expect(get(musicStatus)).toBe('idle');
    expect(get(musicSource)).toBeNull();
  });

  it('does not resume something the person stopped mid-call', () => {
    playSource(A);
    reportPlayerState('playing');
    callStore.setStatus('connected');
    stopMusic();
    callStore.setStatus('idle');
    expect(get(musicStatus)).toBe('idle');
  });
});

/**
 * MICA-111 phase 4 — the channel's own controls.
 *
 * `musicOutputVolume` is the only thing any player element is fed from, on both halves of
 * the feature, so every assertion here is about that number rather than about the two
 * components reading it. What jsdom cannot prove is the last hop: that a `setVolume`
 * command actually reached a cross-origin YouTube frame and that the sound stopped. That
 * is in-game, and a green run here is not evidence of it.
 */
describe('the music channel', () => {
  it('silences the output without disturbing the level it comes back to', () => {
    playSource(A);
    setMusicMuted(true);
    expect(get(musicOutputVolume)).toBe(0);
    // The point of a mute rather than a slider drag: the number is still there afterwards.
    expect(get(musicVolume)).toBe(0.5);

    setMusicMuted(false);
    expect(get(musicOutputVolume)).toBe(0.5);
  });

  it('mutes rather than pauses, so a broadcast is not pretended to have stopped', () => {
    playSource(A);
    reportPlayerState('playing');
    setMusicMuted(true);
    expect(get(musicStatus)).toBe('playing');
    expect(get(musicSource)).toEqual({ videoId: A, playlistId: null });
  });

  it('wins over the duck, because a fifth of nothing is still nothing', () => {
    playSource(A);
    setMusicMuted(true);
    callStore.setIncoming('5550101');
    expect(get(musicOutputVolume)).toBe(0);

    // And the duck is still there underneath when the mute comes off.
    setMusicMuted(false);
    expect(get(musicOutputVolume)).toBeCloseTo(0.1);
    callStore.setStatus('idle');
    expect(get(musicOutputVolume)).toBe(0.5);
  });

  it('follows the slider to zero and back, so the two controls cannot disagree', () => {
    setMusicVolume(0);
    expect(get(musicMuted)).toBe(true);

    // Moving off zero is the person asking to hear it again; a mute that survived that
    // would read as the slider not working.
    setMusicVolume(0.3);
    expect(get(musicMuted)).toBe(false);
    expect(get(musicOutputVolume)).toBeCloseTo(0.3);
  });

  it('toggles', () => {
    toggleMusicMute();
    expect(get(musicMuted)).toBe(true);
    toggleMusicMute();
    expect(get(musicMuted)).toBe(false);
  });

  it('refuses a level that is not a number', () => {
    // `musicOutputVolume` is multiplied by an attenuation and rounded into a `setVolume`
    // command for a cross-origin player. A NaN there is silence with every control still
    // claiming half.
    setMusicVolume(Number.NaN);
    expect(get(musicVolume)).toBe(0);
    expect(get(musicOutputVolume)).toBe(0);
  });

  it('clamps a level from outside the range', () => {
    setMusicVolume(5);
    expect(get(musicVolume)).toBe(1);
    setMusicVolume(-1);
    expect(get(musicVolume)).toBe(0);
  });
});

describe('surviving a restart', () => {
  /**
   * A fresh module graph, which is what a resource restart produces.
   *
   * The seeding happens *inside* it, after `resetModules` and before `music.ts` is
   * imported, and that order is the whole trick: `music.ts` reads its persisted state once,
   * at module scope, so anything written afterwards is written to a module that has already
   * made up its mind. Storage falls back to a module-scope `Map` that `resetModules`
   * replaces along with everything else, which is what gives each case a clean slate —
   * still true after MICA-176 moved this file to jsdom, because this jsdom environment
   * provides `window` but no `localStorage` (verified: `window.localStorage` is
   * `undefined`), so `getStorageBackend()` takes the same in-memory path it took under
   * node. If that ever changes, the `Map` stops being the backing store and each case will
   * start inheriting the previous one's seed.
   *
   * **`facets/storage` alone first, then the whole set only after seeding.** MICA-176
   * made every test file name a facet set, and the obvious edit here — re-import the whole
   * set right after `resetModules`, the way every other file does — is wrong, silently:
   * the set includes `inProcess/facets/music.ts`, which imports `shell/state/music.ts`,
   * so it evaluates the module under test before a single key has been seeded and every
   * assertion below sees an empty queue. `useStorage` needs only the `storage` facet to
   * seed, so that is the one imported early.
   */
  const restart = async (seed: Record<string, unknown>) => {
    vi.resetModules();
    await import('../../host/facets/storage');
    const { useStorage } = await import('../../../../sdk/host/useStorage');
    const storage = useStorage('settings');
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    await import('../../host/registerFacets');
    return import('./music');
  };

  it('brings the queue back and waits to be told to play', async () => {
    const music = await restart({
      musicQueue: [
        { key: 'q1', videoId: A, playlistId: null, title: 'Kept' },
        { key: 'q2', videoId: B, playlistId: null, title: null }
      ],
      musicRepeat: 'all'
    });
    expect(get(music.musicQueue).map((entry) => entry.videoId)).toEqual([A, B]);
    expect(get(music.musicQueue)[0].title).toBe('Kept');
    expect(get(music.musicRepeat)).toBe('all');

    // The important half. A restored *index* would be a restored `musicSource`, and a
    // non-null source is an embed with `autoplay=1` in the page — the phone would start
    // playing on its own every time the resource restarted.
    expect(get(music.musicStatus)).toBe('idle');
    expect(get(music.musicSource)).toBeNull();
  });

  it('resumes from where the queue was left rather than the top', async () => {
    const music = await restart({
      musicQueue: [
        { key: 'q1', videoId: A, playlistId: null, title: null },
        { key: 'q2', videoId: B, playlistId: null, title: null }
      ],
      musicResumeIndex: 1
    });
    music.resumeMusic();
    expect(get(music.musicSource)).toEqual({ videoId: B, playlistId: null });
  });

  it('drops a stored row it would refuse to play', async () => {
    // Storage is not a trusted source for something that ends up in an `<iframe src>`, and
    // the ids are re-checked here exactly as `embedUrlFor` re-checks them.
    const music = await restart({
      musicQueue: [
        { key: 'q1', videoId: '../../evil', playlistId: null, title: 'hostile' },
        { key: 'q2', videoId: null, playlistId: null, title: 'empty' },
        'not an object',
        { key: 'q3', videoId: A, playlistId: null, title: null }
      ]
    });
    expect(get(music.musicQueue).map((entry) => entry.videoId)).toEqual([A]);
  });

  it('keeps a row failure across the restart, and clears it by trying again', async () => {
    const music = await restart({
      musicQueue: [
        {
          key: 'q1',
          videoId: A,
          playlistId: null,
          title: null,
          error: { reason: 'unavailable', code: 100 }
        },
        {
          key: 'q2',
          videoId: B,
          playlistId: null,
          title: null,
          error: { reason: 'nonsense', code: 'x' }
        }
      ]
    });
    expect(get(music.musicQueue)[0].error).toEqual({ reason: 'unavailable', code: 100 });
    // A stored shape nobody would have written is not a verdict.
    expect(get(music.musicQueue)[1].error).toBeUndefined();

    // Playing it again is asking again, so the verdict comes off — and the sanitiser
    // drops the key entirely on the way to storage rather than storing a null.
    music.playQueueIndex(0);
    expect(get(music.musicQueue)[0].error).toBeUndefined();
  });

  it('brings the music channel back, level and mute together', async () => {
    // Both are preferences and are stored under `settings` beside `soundVolume`, so they
    // sync with the character rather than living on one machine. A mute that forgot itself
    // across a restart would be somebody's music coming back on by itself.
    const music = await restart({ musicVolume: 0.25, musicMuted: true });
    expect(get(music.musicVolume)).toBe(0.25);
    expect(get(music.musicMuted)).toBe(true);
    expect(get(music.musicOutputVolume)).toBe(0);
  });

  it('refuses a stored mute that is not a boolean', async () => {
    const music = await restart({ musicMuted: 'yes' });
    expect(get(music.musicMuted)).toBe(false);
  });

  it('caps what a restart can be made to carry', async () => {
    const music = await restart({
      musicQueue: Array.from({ length: 150 }, (_, i) => ({
        key: `q${i}`,
        videoId: A,
        playlistId: null,
        title: null
      }))
    });
    expect(get(music.musicQueue)).toHaveLength(100);
  });
});
