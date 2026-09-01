// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import NowPlaying from './NowPlaying.svelte';
import NotificationShade from './NotificationShade.svelte';
import { musicStatus, playSource, resetMusicForTest } from './state/music';
import { dndEnabled, appNotificationPolicies } from './state/notificationPolicy';
import { isShadeOpen, openShade } from './state/shade';
import { currentApp } from './state/navigation';

/**
 * MICA-111 phase 4, shell half.
 *
 * The bug behind this row is that music outlives the phone being closed and had no off
 * switch outside the Music app. So the cases worth holding down are the ones where the
 * control could go missing while the track keeps running — a Do Not Disturb that has
 * nothing to do with music, a per-app mute on `music`, or a dismiss affordance somebody
 * adds later — plus the plain fact that stopping actually stops.
 */

// jsdom has no Web Animations API and the shade's `transition:fly` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const VIDEO = 'dQw4w9WgXcQ';

beforeEach(() => {
  resetMusicForTest();
  dndEnabled.set(false);
  appNotificationPolicies.set({});
});

/**
 * Every control the card is offering, in DOM order.
 *
 * Takes an already-rendered row rather than rendering one, so a test can watch the set
 * change without mounting a second card — two of them in the document is two
 * `data-testid="now-playing"` nodes and every query after that is ambiguous.
 */
const labelsOf = (row: HTMLElement) =>
  Array.from(row.querySelectorAll('button')).map(
    (b) => b.getAttribute('aria-label') ?? b.getAttribute('title')
  );

/** Render, and read the controls off it once. */
const controls = async () => {
  const { findByTestId } = render(NowPlaying);
  return labelsOf(await findByTestId('now-playing'));
};

describe('NowPlaying', () => {
  it('renders nothing at all when no music is loaded', () => {
    const { queryByTestId } = render(NowPlaying);
    expect(queryByTestId('now-playing')).toBeNull();
  });

  it('appears as soon as something is loaded', async () => {
    const { findByTestId } = render(NowPlaying);
    playSource(`https://youtu.be/${VIDEO}`);
    expect(await findByTestId('now-playing')).toBeTruthy();
  });

  it('names the track by its id until the player reports a title', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    const { findByText } = render(NowPlaying);
    expect(await findByText(VIDEO)).toBeTruthy();
  });

  it('prefers the title the player reports, once there is one', async () => {
    const { reportNowPlaying } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    reportNowPlaying({ title: 'Never Gonna Give You Up', videoId: VIDEO });

    const { findByText } = render(NowPlaying);
    expect(await findByText('Never Gonna Give You Up')).toBeTruthy();
  });

  /**
   * The one that matters. Muting notifications is a statement about interruptions; a
   * control the player pulled the shade down to reach is not one, and hiding it would put
   * the phone straight back in the state this ticket is about — audible, and no way to
   * stop it short of opening the app.
   */
  it('is not governed by Do Not Disturb', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    dndEnabled.set(true);
    const { findByTestId } = render(NowPlaying);
    expect(await findByTestId('now-playing')).toBeTruthy();
  });

  it('is not governed by a per-app mute on music either', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    appNotificationPolicies.set({ music: { banner: false, sound: false, badge: false } });
    const { findByTestId } = render(NowPlaying);
    expect(await findByTestId('now-playing')).toBeTruthy();
  });

  /**
   * A refused track must not read as a working one, and the word alone does not achieve
   * that: drawn in `text-primary` it arrives in the same accent as "Playing" and the row
   * still looks fine at the glance it is designed for.
   */
  it('says a refused track cannot play, and colours it as a failure', async () => {
    const { reportPlayerError } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    reportPlayerError(150);

    const { findByText } = render(NowPlaying);
    const word = await findByText("Can't play");
    expect(word.className).toMatch(/text-error/);
    expect(word.className).not.toMatch(/text-primary/);
  });

  it('withholds play/pause on a refused track, and keeps stop', async () => {
    // `resumeMusic` early-returns in the error state, so the button would be dead. Absent
    // beats disabled here: stop is the thing that still works, and previous is the way off
    // the bad track. Next is absent because a one-row queue has no next — see
    // `musicHasNext`, which is `pickNext()` itself rather than a second opinion about it.
    //
    // Shuffle and repeat stay: they are settings on the queue rather than actions on the
    // track, and neither is made meaningless by this one being unplayable.
    const { reportPlayerError } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    reportPlayerError(150);

    expect(await controls()).toEqual([
      'Open Music',
      'Shuffle',
      'Repeat off',
      'Previous track',
      'Stop music'
    ]);
  });

  it('offers no way to dismiss it other than stopping the music', async () => {
    playSource(`https://youtu.be/${VIDEO}`);

    // The exact set, and the assertion is exact on purpose: an extra button here would
    // most likely be a close affordance, which is this ticket's bug in a different shape —
    // a control you can swipe away while the music keeps playing.
    expect(await controls()).toEqual([
      'Open Music',
      'Shuffle',
      'Repeat off',
      'Previous track',
      'Pause',
      'Stop music'
    ]);
  });

  it('offers the whole transport once there is a queue to move through', async () => {
    const { enqueue } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    enqueue('https://youtu.be/M7lc1UVf-VE');

    expect(await controls()).toEqual([
      'Open Music',
      'Shuffle',
      'Repeat off',
      'Previous track',
      'Pause',
      'Next track',
      'Stop music'
    ]);
  });

  it('moves through the queue without opening the app', async () => {
    const { enqueue, musicSource } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    enqueue('https://youtu.be/M7lc1UVf-VE');

    const { findByLabelText } = render(NowPlaying);
    await fireEvent.click(await findByLabelText('Next track'));
    expect(get(musicSource)).toEqual({ videoId: 'M7lc1UVf-VE', playlistId: null });

    await fireEvent.click(await findByLabelText('Previous track'));
    expect(get(musicSource)).toEqual({ videoId: VIDEO, playlistId: null });
  });

  /**
   * A button that does nothing is worse than one that is not offered, and this is the case
   * where that is easy to get wrong: at the end of a queue that is not repeating,
   * `nextTrack` stops the music rather than advancing. Offering Next there would be a
   * control whose label says one thing and whose effect is another.
   */
  it('hides next at the end of a queue that is not repeating', async () => {
    const { enqueue, nextTrack, setRepeat } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    enqueue('https://youtu.be/M7lc1UVf-VE');
    nextTrack();

    const { findByTestId } = render(NowPlaying);
    const row = await findByTestId('now-playing');
    expect(labelsOf(row)).not.toContain('Next track');

    // With repeat on it wraps, so there genuinely is a next and the button comes back.
    // The same card, re-read: `musicHasNext` is a store and the control has to follow it.
    setRepeat('all');
    await tick();
    expect(labelsOf(row)).toContain('Next track');
  });

  /**
   * The shell's Stop is `stopMusic`, never `clearQueue`, and that is a decision rather
   * than an inherited default. The shade is one pull from any screen and is where somebody
   * reaches to kill the noise mid-conversation; everything reachable that cheaply should
   * be recoverable, and throwing away a queue from a one-tap control with no confirmation
   * and no undo is not. The app has room to ask that question properly.
   */
  it('stops the audio and keeps the queue', async () => {
    const { enqueue, musicQueue } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    enqueue('https://youtu.be/M7lc1UVf-VE');
    expect(get(musicQueue)).toHaveLength(2);

    const { findByLabelText } = render(NowPlaying);
    await fireEvent.click(await findByLabelText('Stop music'));

    expect(get(musicStatus)).toBe('idle');
    expect(get(musicQueue)).toHaveLength(2);
  });

  it('stops the music, and takes itself away with it', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    const { findByLabelText, queryByTestId } = render(NowPlaying);

    await fireEvent.click(await findByLabelText('Stop music'));

    expect(get(musicStatus)).toBe('idle');
    expect(queryByTestId('now-playing')).toBeNull();
  });

  it('pauses and resumes without unloading the track', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    const { findByLabelText } = render(NowPlaying);

    await fireEvent.click(await findByLabelText('Pause'));
    expect(get(musicStatus)).toBe('paused');

    await fireEvent.click(await findByLabelText('Play'));
    expect(get(musicStatus)).toBe('playing');
  });

  it('closes the shade on the way to the app, which is underneath it', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    openShade();
    const { findByTitle } = render(NowPlaying);

    await fireEvent.click(await findByTitle('Open Music'));

    expect(get(isShadeOpen)).toBe(false);
    expect(get(currentApp).id).toBe('music');
  });
});

describe('NowPlaying in the shade', () => {
  /**
   * Placement, asserted rather than described. Below the notification list the control
   * would be past a scroller of unbounded length — off-screen exactly when a lot is going
   * on, which is the one situation a reach-it-without-the-app control may not be.
   */
  it('sits above the notification list', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    openShade();
    const { findByTestId, container } = render(NotificationShade);
    const row = await findByTestId('now-playing');

    const list = container.querySelector('.overflow-y-auto');
    expect(list).toBeTruthy();
    expect(row.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});

describe('the scrubber', () => {
  /**
   * No duration, no scrubber, and that is not the same as a zero-length track: the player
   * reports `0` until it knows, and forever for a live stream. A slider that cannot move
   * is a lie about what is playing.
   */
  it('is absent until the player has reported a duration', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    const { queryByLabelText } = render(NowPlaying);
    expect(queryByLabelText('Seek')).toBeNull();
  });

  it('appears once there is something to scrub, and moves the playhead', async () => {
    const { reportPlayerProgress, musicPosition } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    reportPlayerProgress({ currentTime: 10, duration: 240 });

    const { findByLabelText } = render(NowPlaying);
    const slider = (await findByLabelText('Seek')) as HTMLInputElement;

    // A native range input, so it is keyboard-operable without any work of ours — which a
    // div-and-pointer scrubber would not be, and axe would not have caught.
    expect(slider.tagName).toBe('INPUT');
    expect(slider.type).toBe('range');
    expect(slider.max).toBe('240');

    await fireEvent.change(slider, { target: { value: '90' } });
    expect(get(musicPosition).current).toBe(90);
  });

  it('is withheld on a refused track, like the rest of the transport', async () => {
    const { reportPlayerError, reportPlayerProgress } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    reportPlayerProgress({ currentTime: 10, duration: 240 });
    reportPlayerError(150);

    const { queryByLabelText } = render(NowPlaying);
    expect(queryByLabelText('Seek')).toBeNull();
  });
});

describe('saying it is audible to other people', () => {
  /**
   * Broadcasting is on by default (MICA-111 phase 2): pressing Play makes you audible to
   * the street and there is no toggle. Somebody who started a track and put the phone away
   * is not looking at the Music app, so this row is the only thing that can tell them.
   */
  it('says so while sound is coming out', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    const { findByText } = render(NowPlaying);
    expect(await findByText(/Out loud/)).toBeTruthy();
  });

  it('does not say so while paused, which would be crying wolf', async () => {
    const { pauseMusic } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    pauseMusic();

    const { queryByText } = render(NowPlaying);
    expect(queryByText(/Out loud/)).toBeNull();
  });
});

describe("other people's music", () => {
  /**
   * The gate the lead asked for, and it is a test rather than a runtime branch.
   *
   * A transport control over a stranger's stereo would be absurd, and there is nothing in
   * this component to guard against it: it reads `musicSource`, which is derived from the
   * *local* queue, and `state/nearbyMusic.ts` neither writes that store nor shares one with
   * it. A runtime check would be a branch that can never be true and would read as though
   * it could — so what holds the property is this, which fails the day somebody wires a
   * remote source into the local store.
   */
  it('renders nothing for a nearby broadcast, however loud it is', async () => {
    const { receiveNearbyBroadcasts, receiveNearbyVolumes, audibleBroadcasts } =
      await import('./state/nearbyMusic');
    receiveNearbyBroadcasts([
      {
        source: 42,
        token: 'someone',
        label: 'Frank Nitti',
        videoId: VIDEO,
        playlistId: null,
        startedAt: Date.now(),
        paused: false
      }
    ]);
    receiveNearbyVolumes({ 42: 1 });
    expect(get(audibleBroadcasts)).toHaveLength(1);

    const { queryByTestId } = render(NowPlaying);
    expect(queryByTestId('now-playing')).toBeNull();
  });
});
