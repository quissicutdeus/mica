// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import NearbyMusic from './NearbyMusic.svelte';
import NotificationShade from './NotificationShade.svelte';
import {
  audibleBroadcasts,
  muteAllNearby,
  receiveNearbyBroadcasts,
  receiveNearbyVolumes,
  resetNearbyMusicForTest
} from './state/nearbyMusic';
import { dndEnabled, appNotificationPolicies } from './state/notificationPolicy';
import { isShadeOpen, openShade } from './state/shade';
import { currentApp } from './state/navigation';

/**
 * The global "mute all nearby music" switch, in the shade. MICA-111 phase 2.
 *
 * The ticket promoted mute from an open question to a requirement, and gave the reason:
 * the first person to play something appalling in a crowded area is otherwise unmuteable
 * by everyone in earshot. This is the half of that which has to be reachable *while it is
 * happening* — one pull from any screen, no idea needed of whose music it is, no app to
 * find first.
 *
 * So the cases held down here are the ones where the switch could go missing while the
 * noise carried on: a Do Not Disturb that has nothing to say about it, a per-app mute on
 * `music`, a dismiss affordance somebody adds later, and — the subtle one — hiding the row
 * once the mute is on, which would take away the only way back.
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

/**
 * `source` is derived from the token because the roster carries both and the volume map is
 * keyed on `source` alone — see `state/nearbyMusic.test.ts` for why that join matters.
 */
const sourceOf = (token: string): number => 100 + token.charCodeAt(0);

const row = (token: string, label: string | null = null) => ({
  source: sourceOf(token),
  token,
  label,
  videoId: VIDEO,
  playlistId: null,
  startedAt: Date.now(),
  paused: false
});

const nearby = (tokens: string[]) => {
  receiveNearbyBroadcasts(tokens.map((token) => row(token)));
  receiveNearbyVolumes(
    Object.fromEntries(tokens.map((token, i) => [String(sourceOf(token)), 0.9 - i * 0.1]))
  );
};

beforeEach(() => {
  resetNearbyMusicForTest();
  dndEnabled.set(false);
  appNotificationPolicies.set({});
});

describe('NearbyMusic', () => {
  it('renders nothing at all when nobody nearby is playing', () => {
    const { queryByTestId } = render(NearbyMusic);
    expect(queryByTestId('nearby-music')).toBeNull();
  });

  it('appears as soon as somebody nearby starts something', async () => {
    const { findByTestId } = render(NearbyMusic);
    nearby(['a']);
    expect(await findByTestId('nearby-music')).toBeTruthy();
  });

  it('silences everybody in one tap, without needing to know who', async () => {
    nearby(['a', 'b']);
    const { findByLabelText } = render(NearbyMusic);

    await fireEvent.click(await findByLabelText('Mute all nearby music'));
    expect(get(muteAllNearby)).toBe(true);
    expect(get(audibleBroadcasts)).toEqual([]);
  });

  /**
   * The one that would have been tidier to get wrong. Hiding the row once the mute is on
   * removes the only way back — and a person who threw the switch last week and has
   * forgotten needs to see, at the moment music is actually being played near them, that
   * the silence is theirs rather than a fault.
   */
  it('stays visible while the mute is on, because it is also the way back', async () => {
    nearby(['a']);
    const { findByTestId, findByLabelText } = render(NearbyMusic);

    await fireEvent.click(await findByLabelText('Mute all nearby music'));
    expect(await findByTestId('nearby-music')).toBeTruthy();

    await fireEvent.click(await findByLabelText('Unmute nearby music'));
    expect(get(muteAllNearby)).toBe(false);
  });

  it('says the cap is a rule rather than letting it read as a fault', async () => {
    nearby(['a', 'b', 'c', 'd', 'e']);
    const { findByText } = render(NearbyMusic);
    // Without this line, somebody standing in a crowd hears three of the five stereos
    // around them and has no way to learn that that is deliberate.
    expect(await findByText(/5 people nearby · playing the closest 3/)).toBeTruthy();
  });

  it('is not governed by Do Not Disturb', async () => {
    nearby(['a']);
    dndEnabled.set(true);
    const { findByTestId } = render(NearbyMusic);
    // DND is a statement about interruptions. Somebody else's music is not an
    // interruption the phone raised, and the switch for it is not a notification.
    expect(await findByTestId('nearby-music')).toBeTruthy();
  });

  it('is not governed by a per-app mute on music either', async () => {
    nearby(['a']);
    appNotificationPolicies.set({ music: { banner: false, sound: false, badge: false } });
    const { findByTestId } = render(NearbyMusic);
    expect(await findByTestId('nearby-music')).toBeTruthy();
  });

  it('offers no way to dismiss it other than the mute', async () => {
    nearby(['a']);
    const { findByTestId } = render(NearbyMusic);
    const control = await findByTestId('nearby-music');

    // Two controls exactly: open the app, and the switch. A third here would most likely
    // be a close affordance — which is the original problem in a different shape, since
    // dismissing the control does nothing about the noise.
    const labels = Array.from(control.querySelectorAll('button')).map(
      (b) => b.getAttribute('aria-label') ?? b.getAttribute('title')
    );
    expect(labels).toEqual(['Open Music', 'Mute all nearby music']);
  });

  it('closes the shade on the way to the app, which is underneath it', async () => {
    nearby(['a']);
    openShade();
    const { findByTitle } = render(NearbyMusic);

    await fireEvent.click(await findByTitle('Open Music'));

    expect(get(isShadeOpen)).toBe(false);
    expect(get(currentApp).id).toBe('music');
  });
});

describe('NearbyMusic in the shade', () => {
  it('sits above the notification list, where a scroller cannot push it off-screen', async () => {
    nearby(['a']);
    openShade();
    const { findByTestId, container } = render(NotificationShade);
    const control = await findByTestId('nearby-music');

    const list = container.querySelector('.overflow-y-auto');
    expect(list).toBeTruthy();
    expect(control.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
