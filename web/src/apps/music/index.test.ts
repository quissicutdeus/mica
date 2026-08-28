// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { renderApp } from '@gphone/sdk/testing';
import { fireEvent } from '@testing-library/svelte';
import Music from './index.svelte';
import {
  musicIndex,
  musicQueue,
  musicSource,
  musicStatus,
  reportNowPlaying,
  reportPlayerError,
  resetMusicForTest
} from '../../shell/state/music';

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

    await fireEvent.click(await findByLabelText('Next'));
    expect(get(musicSource)).toEqual({ videoId: OTHER, playlistId: null });

    await fireEvent.click(await findByLabelText('Previous'));
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

    await fireEvent.click(await findByLabelText('Stop'));
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
    expect(await findByText("Can't play this")).toBeTruthy();
    // Nothing to press: the player has refused this video, and a Play button that does
    // nothing is how a person concludes the phone is broken rather than the link.
    expect((queryByLabelText('Play') as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  it('leaves the reason on the row after moving past it', async () => {
    const { getByLabelText, findByText, findByLabelText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);
    await type(getByLabelText, OTHER);
    await fireEvent.click(await findByText('Queue'));

    reportPlayerError(100);
    await fireEvent.click(await findByLabelText('Next'));
    expect(await findByText(/Unavailable — removed or private/)).toBeTruthy();
  });

  it('says out loud that nobody else can hear it', async () => {
    // Phase 1 is local playback. A music app that looks like a boombox and is not one has
    // to say so on the screen, not in a ticket.
    const { findByText } = renderApp(Music, { id: 'music' });
    expect(await findByText(/Only you can hear this/)).toBeTruthy();
  });
});
