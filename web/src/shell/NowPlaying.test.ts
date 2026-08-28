// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    // beats disabled in a three-control row: stop is the thing that still works.
    const { reportPlayerError } = await import('./state/music');
    playSource(`https://youtu.be/${VIDEO}`);
    reportPlayerError(150);

    const { findByTestId } = render(NowPlaying);
    const row = await findByTestId('now-playing');
    const labels = Array.from(row.querySelectorAll('button')).map(
      (b) => b.getAttribute('aria-label') ?? b.getAttribute('title')
    );
    expect(labels).toEqual(['Open Music', 'Stop music']);
  });

  it('offers no way to dismiss it other than stopping the music', async () => {
    playSource(`https://youtu.be/${VIDEO}`);
    const { findByTestId } = render(NowPlaying);
    const row = await findByTestId('now-playing');

    // Three controls exactly: open the app, pause/play, stop. A fourth button here would
    // most likely be a close affordance, which is the bug in a different shape.
    const labels = Array.from(row.querySelectorAll('button')).map(
      (b) => b.getAttribute('aria-label') ?? b.getAttribute('title')
    );
    expect(labels).toEqual(['Open Music', 'Pause', 'Stop music']);
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
