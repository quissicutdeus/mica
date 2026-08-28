// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import MediaThumb from './MediaThumb.svelte';
import type { MediaItem } from '@shared/types';

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
});
