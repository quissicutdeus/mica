// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { renderApp } from '@gphone/sdk/testing';
import { fireEvent } from '@testing-library/svelte';
import Music from './index.svelte';
import { musicSource, musicStatus, resetMusicForTest } from '../../shell/state/music';

/**
 * MICA-111 phase 1. This proves the app is a *controller* — that what it does lands in
 * shell state rather than in state of its own — which is the property the whole design
 * rests on, because the player has to keep running when this component is destroyed.
 *
 * It cannot prove anything about the embed: jsdom loads no iframe, and CEF is not here.
 */

const VIDEO = 'dQw4w9WgXcQ';

beforeEach(() => resetMusicForTest());

const paste = async (getByLabelText: (t: string) => HTMLElement, value: string) => {
  const field = getByLabelText('YouTube link') as HTMLInputElement;
  await fireEvent.input(field, { target: { value } });
  await fireEvent.keyDown(field, { key: 'Enter' });
  return field;
};

describe('Music', () => {
  it('starts with nothing playing', async () => {
    const { findByText } = renderApp(Music, { id: 'music' });
    expect(await findByText('Nothing playing')).toBeTruthy();
  });

  it('puts a pasted link into shell state, not its own', async () => {
    const { getByLabelText, findByText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, `https://youtu.be/${VIDEO}`);

    expect(get(musicSource)).toEqual({ videoId: VIDEO, playlistId: null });
    expect(get(musicStatus)).toBe('loading');
    expect(await findByText(VIDEO)).toBeTruthy();
  });

  it('says so, and changes nothing, when the paste is not a YouTube link', async () => {
    const { getByLabelText, findByText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, 'https://example.com/track.mp3');

    expect(await findByText(/doesn't look like a YouTube link/)).toBeTruthy();
    expect(get(musicSource)).toBeNull();
  });

  it('pauses and resumes through the shell', async () => {
    const { getByLabelText, findByLabelText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);

    await fireEvent.click(await findByLabelText('Pause'));
    expect(get(musicStatus)).toBe('paused');

    await fireEvent.click(await findByLabelText('Play'));
    expect(get(musicStatus)).toBe('playing');
  });

  it('stop unloads the source', async () => {
    const { getByLabelText, findByLabelText } = renderApp(Music, { id: 'music' });
    await paste(getByLabelText, VIDEO);

    await fireEvent.click(await findByLabelText('Stop'));
    expect(get(musicSource)).toBeNull();
    expect(get(musicStatus)).toBe('idle');
  });

  it('says out loud that nobody else can hear it', async () => {
    // Phase 1 is local playback. A music app that looks like a boombox and is not one has
    // to say so on the screen, not in a ticket.
    const { findByText } = renderApp(Music, { id: 'music' });
    expect(await findByText(/Only you can hear this/)).toBeTruthy();
  });
});
