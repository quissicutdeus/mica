// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/** In-process facets: a unit test stands in for the shell (MICA-176). */
import '../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import BoundMusicFrame from './__fixtures__/BoundMusicFrame.svelte';

/**
 * MICA-360: a volume that moved without crossing an integer is the same `setVolume` the
 * player already has, and is not posted again. jsdom never loads the embed, so what is
 * under test is what this component posts into the frame's window, not what YouTube does
 * with it.
 */

const URL_A = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1';
const URL_B = 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?enablejsapi=1';

/** Stand in for the frame's window, then fire the `load` the real embed would. */
async function loadWithSpy(iframe: HTMLIFrameElement) {
  const post = vi.fn();
  Object.defineProperty(iframe.contentWindow!, 'postMessage', { value: post });
  await fireEvent.load(iframe);
  return post;
}

const setVolumes = (post: ReturnType<typeof vi.fn>): number[] =>
  post.mock.calls
    .map(([message]) => JSON.parse(String(message)) as { func?: string; args?: number[] })
    .filter((m) => m.func === 'setVolume')
    .map((m) => m.args?.[0] ?? NaN);

async function loaded(volume: number) {
  const view = render(BoundMusicFrame, { props: { url: URL_A, volume } });
  const post = await loadWithSpy(view.container.querySelector('iframe')!);
  const frame = view.component as unknown as {
    setVolume: (next: number) => void;
    setUrl: (next: string) => void;
  };
  return {
    container: view.container,
    post,
    setVolume: (next: number) => flushSync(() => frame.setVolume(next)),
    setUrl: (next: string) => flushSync(() => frame.setUrl(next))
  };
}

describe('MusicFrame volume', () => {
  it('posts the level once on load, not again when the effect sees ready', async () => {
    const { post } = await loaded(0.5);
    expect(setVolumes(post)).toEqual([50]);
  });

  it('skips a float change that rounds to the level already posted', async () => {
    const { post, setVolume } = await loaded(0.5);
    setVolume(0.501);
    setVolume(0.4999);
    expect(setVolumes(post)).toEqual([50]);
  });

  it('posts each change that moves the integer level', async () => {
    const { post, setVolume } = await loaded(0.5);
    setVolume(0.52);
    setVolume(0.5);
    expect(setVolumes(post)).toEqual([50, 52, 50]);
  });

  it('tells a new player its level even when it matches the old one', async () => {
    const { post, setUrl, container } = await loaded(0.5);
    setUrl(URL_B);
    const fresh = container.querySelector('iframe')!;
    const freshPost = await loadWithSpy(fresh);
    expect(setVolumes(post)).toEqual([50]);
    expect(setVolumes(freshPost)).toEqual([50]);
  });
});
