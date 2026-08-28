import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  YOUTUBE_EMBED_ORIGIN,
  embedUrlFor,
  musicSource,
  musicStatus,
  pauseMusic,
  playSource,
  playerCommand,
  reportPlayerState,
  resetMusicForTest,
  resumeMusic,
  stopMusic
} from './music';

/**
 * MICA-111 phase 1. What these can and cannot prove is worth saying up front: this is
 * jsdom, so nothing here exercises the embed, CEF, or the autoplay policy — the three
 * things the phase exists to answer. What it does hold down is the part that would be a
 * *security* bug rather than a "does not work" bug: the only thing ever interpolated into
 * the frame's `src` is a validated id, and the origin is a constant.
 */

beforeEach(() => resetMusicForTest());

const VIDEO = 'dQw4w9WgXcQ';
const PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';

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
