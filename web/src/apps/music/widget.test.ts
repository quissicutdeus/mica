// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { fireEvent } from '@testing-library/svelte';
import { renderApp } from '@mica/sdk/testing';
import Widget from './widget.svelte';
import manifest from './manifest';
import { musicStatus, playSource, enqueue, resetMusicForTest } from '../../shell/state/music';
import { reportNowPlaying } from '../../shell/state/music';
import { currentApp } from '../../shell/state/navigation';

/**
 * MICA-245: Music's widget is a controller over the same shell state the app is, so what
 * is worth pinning is that its buttons land there, that it names what is playing the way
 * the card does, and that it has an empty state which opens the app.
 */

const VIDEO = 'dQw4w9WgXcQ';
const OTHER = 'aaaaaaaaaaa';

const mount = (size: '2x1' | '2x2') =>
  renderApp(Widget as never, { id: 'music', props: { size } as never });

beforeEach(() => resetMusicForTest());

describe('Music widget', () => {
  it('is declared on the manifest at both sizes', () => {
    expect(manifest.widget?.sizes).toEqual(['2x1', '2x2']);
  });

  it.each(['2x1', '2x2'] as const)('shows an empty state at %s that opens Music', async (size) => {
    const { getByTestId } = mount(size);
    currentApp.set({ id: 'home', props: {} });
    await fireEvent.click(getByTestId('widget-music-empty'));
    expect(get(currentApp).id).toBe('music');
  });

  it.each(['2x1', '2x2'] as const)('names the track and falls back to its id at %s', (size) => {
    playSource(VIDEO);
    const { getByTestId } = mount(size);
    expect(getByTestId('widget-music-title').textContent).toBe(VIDEO);
  });

  it('shows the reported title, and updates when it changes', async () => {
    playSource(VIDEO);
    const { getByTestId, findByText } = mount('2x2');
    reportNowPlaying({
      title: 'Never Gonna',
      videoId: VIDEO,
      playlistIndex: null,
      playlistCount: null
    });
    expect(await findByText('Never Gonna')).toBeTruthy();
    expect(getByTestId('widget-music')).toBeTruthy();
  });

  it.each(['2x1', '2x2'] as const)('pause and play drive the shell player at %s', async (size) => {
    playSource(VIDEO);
    const { getByRole } = mount(size);
    await fireEvent.click(getByRole('button', { name: 'Pause' }));
    expect(get(musicStatus)).toBe('paused');
    await fireEvent.click(getByRole('button', { name: 'Play' }));
    expect(['playing', 'loading']).toContain(get(musicStatus));
  });

  it('offers Next only when there is one, and advances the queue', async () => {
    playSource(VIDEO);
    const { queryByRole, findByRole } = mount('2x1');
    expect(queryByRole('button', { name: 'Next track' })).toBeNull();
    enqueue(OTHER);
    await fireEvent.click(await findByRole('button', { name: 'Next track' }));
    expect(get(musicStatus)).not.toBe('idle');
  });

  it('opens Music from the track', async () => {
    playSource(VIDEO);
    const { getByLabelText } = mount('2x2');
    currentApp.set({ id: 'home', props: {} });
    await fireEvent.click(getByLabelText(/^Open Music/));
    expect(get(currentApp).id).toBe('music');
  });
});
