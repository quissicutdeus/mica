// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { renderApp } from '@gos/sdk/testing';
import { fireEvent } from '@testing-library/svelte';
import Music from './index.svelte';
import {
  musicIndex,
  musicQueue,
  musicSource,
  musicStatus,
  reportNowPlaying,
  reportPlayerError,
  resetMusicForTest,
  setMusicMuted,
  setMusicVolume
} from '../../shell/state/music';
import {
  audibleBroadcasts,
  receiveNearbyBroadcasts,
  receiveNearbyVolumes,
  resetNearbyMusicForTest
} from '../../shell/state/nearbyMusic';

/**
 * MICA-111 phases 1 and 3. This proves the app is a *controller* — that what it does
 * lands in shell state rather than in state of its own — which is the property the whole
 * design rests on, because the player and the queue both have to survive this component
 * being destroyed.
 *
 * It cannot prove anything about the embed: jsdom loads no iframe, and CEF is not here.
 * Nor can it prove a title ever arrives, since the only thing that sends one is the
 * player; what it does prove is that the screen reads correctly when one does not.
 */

const VIDEO = 'dQw4w9WgXcQ';
const OTHER = 'aaaaaaaaaaa';

beforeEach(() => resetMusicForTest());

const type = async (getByLabelText: (t: string) => HTMLElement, value: string) => {
  const field = getByLabelText('YouTube link') as HTMLInputElement;
  await fireEvent.input(field, { target: { value } });
  return field;
};

const paste = async (getByLabelText: (t: string) => HTMLElement, value: string) => {
  const field = await type(getByLabelText, value);
  await fireEvent.keyDown(field, { key: 'Enter' });
  return field;
};

describe('Music', () => {
  it('starts with nothing queued', async () => {
    const { findByText } = renderApp(Music, { id: 'music' });
    expect(await findByText('Nothing queued')).toBeTruthy();
  });

  it('puts a pasted link into shell state, not its own', async () => {
    const { getByLabelText, findAllByText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, `https://youtu.be/${VIDEO}`);

    expect(get(musicSource)).toEqual({ videoId: VIDEO, playlistId: null });
    expect(get(musicStatus)).toBe('loading');
    // Twice: once in the now-playing card, once as the queue row it created. The id is the
    // label until the player reports a title, and it may never.
    expect(await findAllByText(VIDEO)).toHaveLength(2);
  });

  it('says so, and changes nothing, when the paste is not a YouTube link', async () => {
    const { getByLabelText, findByText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, 'https://example.com/track.mp3');

    expect(await findByText(/doesn't look like a YouTube link/)).toBeTruthy();
    expect(get(musicSource)).toBeNull();
  });

  it('queues without starting, and plays what was queued on demand', async () => {
    const { getByLabelText, findByText, findByLabelText } = renderApp(Music, { id: 'music' });
    await type(getByLabelText, VIDEO);
    await fireEvent.click(await findByText('Queue'));

    expect(get(musicQueue)).toHaveLength(1);
    expect(get(musicStatus)).toBe('idle');

    await fireEvent.click(await findByLabelText('Play'));
    expect(get(musicIndex)).toBe(0);
  });

  it('skips and removes through the shell', async () => {
    const { getByLabelText, findByText, findByLabelText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);
    await type(getByLabelText, OTHER);
    await fireEvent.click(await findByText('Queue'));

    await fireEvent.click(await findByLabelText('Next track'));
    expect(get(musicSource)).toEqual({ videoId: OTHER, playlistId: null });

    await fireEvent.click(await findByLabelText('Previous track'));
    expect(get(musicSource)).toEqual({ videoId: VIDEO, playlistId: null });

    await fireEvent.click(await findByLabelText(`Remove ${VIDEO} from the queue`));
    expect(get(musicQueue).map((entry) => entry.videoId)).toEqual([OTHER]);
  });

  it('shows the title the player reported, once it has reported one', async () => {
    const { getByLabelText, findAllByText, queryByText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);
    expect(queryByText('Never Gonna Give You Up')).toBeNull();

    reportNowPlaying({ title: 'Never Gonna Give You Up', videoId: VIDEO });
    // Twice, in both places the id used to be: the card names what is playing and the row
    // remembers it. Nothing was fetched to learn it — see `reportNowPlaying`.
    expect(await findAllByText('Never Gonna Give You Up')).toHaveLength(2);
  });

  it('pauses and resumes through the shell', async () => {
    const { getByLabelText, findByLabelText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);

    await fireEvent.click(await findByLabelText('Pause'));
    expect(get(musicStatus)).toBe('paused');

    await fireEvent.click(await findByLabelText('Play'));
    expect(get(musicStatus)).toBe('playing');
  });

  it('stop unloads the source and keeps the queue', async () => {
    const { getByLabelText, findByLabelText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);

    await fireEvent.click(await findByLabelText('Stop music'));
    expect(get(musicSource)).toBeNull();
    expect(get(musicStatus)).toBe('idle');
    expect(get(musicQueue)).toHaveLength(1);
  });

  it('clear empties the queue', async () => {
    const { getByLabelText, findByText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);

    await fireEvent.click(await findByText('Clear'));
    expect(get(musicQueue)).toHaveLength(0);
    expect(await findByText('Nothing queued')).toBeTruthy();
  });

  it('says why a track will not play, rather than sitting on Starting…', async () => {
    const { getByLabelText, findByText, findAllByText, queryByLabelText } = renderApp(Music, {
      id: 'music'
    });
    await paste(getByLabelText, VIDEO);

    reportPlayerError(150);
    // Twice: the card explains it and offers the way out, the row is labelled so it still
    // says so once the queue has moved on.
    expect(await findAllByText(/Can't be played outside YouTube/)).toHaveLength(2);
    expect(await findByText("Can't play")).toBeTruthy();
    // Nothing to press, and nothing offered: the player has refused this video, so
    // play/pause is absent rather than disabled — the same rule the card applies to
    // previous and next, and the reason Stop is the one control that never goes away.
    expect(queryByLabelText('Play')).toBeNull();
    expect(queryByLabelText('Pause')).toBeNull();
  });

  it('leaves the reason on the row after moving past it', async () => {
    const { getByLabelText, findByText, findByLabelText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);
    await type(getByLabelText, OTHER);
    await fireEvent.click(await findByText('Queue'));

    reportPlayerError(100);
    await fireEvent.click(await findByLabelText('Next track'));
    expect(await findByText(/Unavailable — removed or private/)).toBeTruthy();
  });

  /**
   * The id used to sit under every title, in the now-playing card and the queue row at
   * once — eleven characters of hex-looking text beneath a perfectly good name, twice on
   * one screen, identifying nothing a person cares about.
   */
  it('drops the video id once the player has given the track a name', async () => {
    const { getByLabelText, findAllByText, queryByText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);
    // Before a title, the id *is* the name — in both places, which is the fallback working
    // rather than the duplication this test is about.
    expect(await findAllByText(VIDEO)).toHaveLength(2);

    reportNowPlaying({ title: 'Never Gonna Give You Up', videoId: VIDEO });
    expect(await findAllByText('Never Gonna Give You Up')).toHaveLength(2);
    expect(queryByText(VIDEO)).toBeNull();
  });

  /**
   * The one case that still wants the id, and the one the rule above would otherwise eat:
   * a track that played long enough to be named and *then* was refused. The name is a
   * title, so the id has nowhere else to appear — and this is exactly the row somebody
   * pastes into a bug report or back into the field to check the link themselves.
   */
  it('brings the id back on a row that failed after it had a name', async () => {
    const { getByLabelText, findAllByText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);
    reportNowPlaying({ title: 'Never Gonna Give You Up', videoId: VIDEO });
    reportPlayerError(150);

    expect(await findAllByText(VIDEO)).toHaveLength(2);
  });

  /**
   * The bug: `musicMuted` (Settings > Sound) silenced the channel, but this slider kept
   * reading a percentage it was not actually playing at. `Math.round($musicVolume * 100)%`
   * was true of the stored level and false of the sound coming out — the same
   * `musicMuted`-wins-over-the-number rule Settings' own two sliders already read by
   * (`apps/settings/panes/Sound.svelte`), applied here rather than invented twice.
   */
  it('shows "Muted" instead of a volume it is not playing at', async () => {
    const { getByLabelText, findByText, queryByText } = renderApp(Music, { id: 'music' });

    setMusicVolume(0.4);
    expect(await findByText('40%')).toBeTruthy();

    // Muted the way Settings > Sound mutes it — the store, not the slider — and the label
    // has to follow without anybody having touched this screen.
    setMusicMuted(true);
    expect(await findByText('Muted')).toBeTruthy();
    expect(queryByText('40%')).toBeNull();

    // The level survives the mute: the thumb sits where it was left, not at zero, so
    // unmuting (from Settings, or by dragging here) lands back on 40 and not a default.
    const slider = getByLabelText('Music volume') as HTMLInputElement;
    expect(slider.value).toBe('40');

    setMusicMuted(false);
    expect(await findByText('40%')).toBeTruthy();
  });

  it('says out loud that other people can hear it', async () => {
    // Phase 1 said the opposite, and this assertion flipped with the behaviour rather than
    // being deleted. A phone that plays out loud without telling you it does is how
    // somebody gets shouted at in a bank they thought they were alone in — and the sentence
    // is the only warning there is, since the person broadcasting is the one who cannot
    // tell the difference.
    const { findByText } = renderApp(Music, { id: 'music' });
    expect(await findByText(/People nearby can hear this/)).toBeTruthy();
  });
});

/**
 * The Nearby list — the per-broadcaster half of the mute requirement (MICA-111 phase 2).
 *
 * The global switch is deliberately not only here; `shell/NearbyMusic.svelte` puts it in
 * the notification shade so somebody being harassed does not have to find an app first.
 * What this suite covers is the part that needs a name and a row: who is nearby, which of
 * them this phone is actually rendering, and why the others are not.
 */
describe('nearby broadcasters', () => {
  const nearby = (rows: Partial<Record<string, unknown>>[]) =>
    receiveNearbyBroadcasts(
      rows.map((row, i) => ({
        source: 50 + i,
        token: `tok${i}`,
        label: null,
        videoId: VIDEO,
        playlistId: null,
        startedAt: Date.now(),
        paused: false,
        ...row
      }))
    );

  /** Keyed by `source`, which is what the game client sends. */
  const volumes = (levels: number[]) =>
    receiveNearbyVolumes(Object.fromEntries(levels.map((v, i) => [String(50 + i), v])));

  beforeEach(() => resetNearbyMusicForTest());
  afterEach(() => resetNearbyMusicForTest());

  it('renders nothing at all when nobody nearby is playing', async () => {
    const { queryByText } = renderApp(Music, { id: 'music' });
    await tick();
    expect(queryByText(/^Nearby/)).toBeNull();
  });

  it('names a broadcaster the server named, and does not invent one it did not', async () => {
    nearby([{ label: 'Frank Nitti' }, {}]);
    volumes([0.8, 0.4]);
    const { findByText } = renderApp(Music, { id: 'music' });

    expect(await findByText('Frank Nitti')).toBeTruthy();
    // Never the token. It identifies nobody and means nothing to a person.
    expect(await findByText('Someone nearby')).toBeTruthy();
  });

  it('says the cap is a rule rather than letting it look like a fault', async () => {
    nearby([{}, {}, {}, {}]);
    volumes([0.9, 0.8, 0.7, 0.6]);
    const { findAllByText } = renderApp(Music, { id: 'music' });

    expect((await findAllByText('Playing')).length).toBe(3);
    expect((await findAllByText(/closest 3 only/)).length).toBe(1);
  });

  it('promotes the next broadcaster when the nearest is muted', async () => {
    nearby([{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }, { label: 'Delta' }]);
    volumes([0.9, 0.8, 0.7, 0.6]);
    const { findByLabelText } = renderApp(Music, { id: 'music' });

    expect(get(audibleBroadcasts).map((b) => b.token)).toEqual(['tok0', 'tok1', 'tok2']);

    // A muted broadcaster is not a loser of the cap, it is not a candidate for it — so the
    // fourth is promoted rather than the slot being left empty. Muting the nearest person
    // is how you hear the next one, and that only works because mute is applied before the
    // ranking rather than after it.
    await fireEvent.click(await findByLabelText('Mute Alpha'));
    await tick();
    expect(get(audibleBroadcasts).map((b) => b.token)).toEqual(['tok1', 'tok2', 'tok3']);
  });

  it('turns every per-person toggle off under the global mute rather than hiding them', async () => {
    nearby([{}, {}]);
    volumes([0.9, 0.8]);
    const { findByLabelText, findAllByText } = renderApp(Music, { id: 'music' });

    await fireEvent.click(await findByLabelText('Mute all nearby music'));
    await tick();
    // The rows stay, so the list does not change shape; nothing in it plays.
    expect((await findAllByText(/All nearby music muted/)).length).toBe(2);
    expect(get(audibleBroadcasts)).toEqual([]);
  });
});
