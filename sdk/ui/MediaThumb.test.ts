// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. In-process, because a
 * unit test stands in for the shell — `MediaThumb` reads streamer mode through a host hook
 * since MICA-249.
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import MediaThumb from './MediaThumb.svelte';
import MediaThumbInButton from './__fixtures__/MediaThumbInButton.svelte';
import type { MediaItem } from '@mica/shared/types';
import { setStreamerMode, revealGeneration } from '../../web/src/shell/state/streamerMode';
import { currentApp } from '../../web/src/shell/state/navigation';

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: 1,
  citizenid: 'CID',
  kind: 'photo',
  status: 'active',
  created_at: '2026-08-07T00:00:00Z',
  updated_at: '2026-08-07T00:00:00Z',
  ...over
});

/**
 * One renderer for seven kinds.
 *
 * Every surface that shows media — the gallery grid, the full view, the picker — asks the
 * same question, and four copies of the answer is four places to forget `kind` exists.
 * These pin the branches that differ, not the markup.
 */
describe('MediaThumb', () => {
  it('draws a local capture from its own bytes', () => {
    const { container } = render(MediaThumb, { item: item({ data: 'data:image/png;base64,AAA' }) });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
  });

  it('prefers a thumbnail, which is all a video has to draw', () => {
    // A video's bytes are not in `data` and would not survive the NUI bridge if they were.
    // The poster frame is the only thing that renders at all.
    const { container } = render(MediaThumb, {
      item: item({
        kind: 'video',
        thumbnail: 'https://x.test/poster.jpg',
        url: 'https://x.test/v.mp4'
      })
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://x.test/poster.jpg');
  });

  /**
   * The half of the projection change that is easy to ship broken (MICA-110).
   *
   * A tile wants the smallest thing that draws; a full-screen view wants the original. With
   * one precedence for both, the viewer fetches the bytes and then draws the thumbnail
   * anyway, upscaled — which looks like a working app, so nothing catches it but a test that
   * names the source it expects.
   */
  describe('prefer', () => {
    const both = item({
      thumbnail: 'data:image/webp;base64,SMALL',
      data: 'data:image/png;base64,BIG'
    });

    it('draws the thumbnail by default, which is what a grid tile wants', () => {
      const { container } = render(MediaThumb, { item: both });
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/webp;base64,SMALL'
      );
    });

    it('draws the bytes when the caller asks for the original', () => {
      const { container } = render(MediaThumb, { item: both, prefer: 'original' });
      expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BIG');
    });

    it('still falls back to the thumbnail when there are no bytes to prefer', () => {
      // What the full view shows for the moment before its fetch lands, and for good if the
      // row never had bytes of its own.
      const { container } = render(MediaThumb, {
        item: item({ thumbnail: 'data:image/webp;base64,SMALL' }),
        prefer: 'original'
      });
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/webp;base64,SMALL'
      );
    });

    it('does not promote a url that is not an image, even asked for the original', () => {
      // A video's `url` is an .mp4 and passes a scheme check happily. Which kinds have an
      // image behind a URL is a fact about the row, not a preference of the caller.
      const { container } = render(MediaThumb, {
        item: item({
          kind: 'video',
          thumbnail: 'https://x.test/poster.jpg',
          url: 'https://x.test/v.mp4'
        }),
        prefer: 'original'
      });
      expect(container.querySelector('img')?.getAttribute('src')).toBe('https://x.test/poster.jpg');
    });
  });

  it('falls back to a labelled placeholder when there is nothing to draw', () => {
    // An audio clip has neither bytes nor a poster. An <img> with no src is a broken image
    // icon, which reads as a bug rather than as a voice note.
    const { container, getByText } = render(MediaThumb, {
      item: item({ kind: 'audio', url: 'https://x.test/v.ogg', alt_text: 'Voice note' })
    });
    expect(container.querySelector('img')).toBeNull();
    expect(getByText('Voice note')).toBeTruthy();
  });

  it('refuses a src that could execute', () => {
    // `url` is server-written today, so this is defence in depth — but the value is one
    // refactor away from reaching something that is not an <img>, and §7 is emphatic that
    // a link is a griefing vector in CEF.
    const { container } = render(MediaThumb, {
      item: item({ kind: 'gif', url: 'javascript:alert(1)' })
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('marks a gif and a video so they are not mistaken for stills', () => {
    const gif = render(MediaThumb, { item: item({ kind: 'gif', url: 'https://x.test/a.gif' }) });
    expect(gif.getByText('GIF')).toBeTruthy();

    const video = render(MediaThumb, {
      item: item({ kind: 'video', thumbnail: 'https://x.test/p.jpg', duration_ms: 65_000 })
    });
    // Duration reads as time, not milliseconds.
    expect(video.getByText('1:05')).toBeTruthy();
  });

  it('names the item for a screen reader even without alt text', () => {
    const { container } = render(MediaThumb, {
      item: item({ kind: 'gif', url: 'https://x.test/a.gif' })
    });
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('gif 1');
  });

  /**
   * Streamer mode (MICA-249). What is pinned: the blur is a state the DOM announces
   * (`data-streamer`), the first tap reveals and goes no further, and a reveal is undone
   * by the events after which the streamer no longer expects the picture. Whether the
   * pixels are actually soft is `blur-media` in `app-utilities.css`, and CEF's to render.
   */
  describe('streamer mode', () => {
    const photo = item({ data: 'data:image/png;base64,AAA' });

    beforeEach(() => {
      setStreamerMode(false);
      currentApp.set({ id: 'home', props: {} });
    });

    it('does nothing when the mode is off', () => {
      const { container } = render(MediaThumb, { item: photo });
      const root = container.firstElementChild as HTMLElement;
      expect(root.hasAttribute('data-streamer')).toBe(false);
      expect(container.querySelector('img')?.classList.contains('blur-media')).toBe(false);
      expect(container.querySelector('[role="button"]')).toBeNull();
    });

    it('blurs a still until it is tapped, and the tap goes no further', async () => {
      setStreamerMode(true);
      let opened = 0;
      const { container, getByTestId } = render(MediaThumbInButton, {
        item: photo,
        onopen: () => (opened += 1)
      });
      const root = getByTestId('opener').firstElementChild as HTMLElement;
      expect(root.getAttribute('data-streamer')).toBe('blurred');
      expect(container.querySelector('img')?.classList.contains('blur-media')).toBe(true);
      // Still an <img>: the mode hides, it does not withhold. The picture is the app's to
      // fetch either way (AGENTS.md §7), so a blur that dropped the element would be theatre.
      expect(container.querySelector('img')?.getAttribute('src')).toBe(photo.data);

      await fireEvent.click(container.querySelector('[role="button"]')!);
      expect(root.getAttribute('data-streamer')).toBe('revealed');
      expect(container.querySelector('img')?.classList.contains('blur-media')).toBe(false);
      expect(container.querySelector('[role="button"]')).toBeNull();
      expect(opened, 'the reveal tap must not open the picture').toBe(0);

      // The second tap is an ordinary tap on the tile.
      await fireEvent.click(container.querySelector('img')!);
      expect(opened).toBe(1);
    });

    it('reveals from the keyboard as well', async () => {
      setStreamerMode(true);
      const { container } = render(MediaThumb, { item: photo });
      await fireEvent.keyDown(container.querySelector('[role="button"]')!, { key: 'Enter' });
      expect((container.firstElementChild as HTMLElement).getAttribute('data-streamer')).toBe(
        'revealed'
      );
    });

    it('never blurs a placeholder, which has no picture to hide', () => {
      setStreamerMode(true);
      const { container } = render(MediaThumb, { item: item({ kind: 'audio' }) });
      expect((container.firstElementChild as HTMLElement).hasAttribute('data-streamer')).toBe(
        false
      );
      expect(container.querySelector('[role="button"]')).toBeNull();
    });

    it('re-blurs a mounted thumb when the foreground app changes', async () => {
      setStreamerMode(true);
      const { container } = render(MediaThumb, { item: photo });
      const root = container.firstElementChild as HTMLElement;
      await fireEvent.click(container.querySelector('[role="button"]')!);
      expect(root.getAttribute('data-streamer')).toBe('revealed');

      // A resident app keeps its grid mounted while another app is in front; the reveal
      // must not survive that, since the streamer is no longer expecting the picture.
      const before = get(revealGeneration);
      currentApp.set({ id: 'messages', props: {} });
      await Promise.resolve();
      expect(get(revealGeneration)).toBeGreaterThan(before);
      expect(root.getAttribute('data-streamer')).toBe('blurred');
    });

    it('drops the blur and the attribute the moment the mode is switched off', async () => {
      setStreamerMode(true);
      const { container } = render(MediaThumb, { item: photo });
      const root = container.firstElementChild as HTMLElement;
      expect(root.getAttribute('data-streamer')).toBe('blurred');
      setStreamerMode(false);
      await Promise.resolve();
      expect(root.hasAttribute('data-streamer')).toBe(false);
      expect(container.querySelector('img')?.classList.contains('blur-media')).toBe(false);
    });
  });
});
