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
import MediaThumbInRoleButton from './__fixtures__/MediaThumbInRoleButton.svelte';
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

    /**
     * A photo on an image host (MICA-243) has a `url` and a `thumbnail` and no `data`. The
     * grid wants the thumbnail; the full view wants the hosted original, not the thumbnail
     * upscaled — the same trap as the bytes case above, one column over.
     */
    describe('a hosted photo', () => {
      const hosted = item({
        thumbnail: 'data:image/webp;base64,SMALL',
        url: 'https://img.example.test/p/abc.webp'
      });

      it('draws the thumbnail in a tile', () => {
        const { container } = render(MediaThumb, { item: hosted });
        expect(container.querySelector('img')?.getAttribute('src')).toBe(
          'data:image/webp;base64,SMALL'
        );
      });

      it('draws the hosted original when the caller asks for it', () => {
        const { container } = render(MediaThumb, { item: hosted, prefer: 'original' });
        expect(container.querySelector('img')?.getAttribute('src')).toBe(
          'https://img.example.test/p/abc.webp'
        );
      });
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

  /**
   * MICA-339 (F9). `data` is inline bytes; a remote URL there made every phone that drew the
   * tile request it, handing that host the viewer's IP. The positive twin is the same URL in
   * `url`, where a hosted photo legitimately lives and still draws.
   */
  describe('a remote URL in data', () => {
    const BEACON = 'https://logger.attacker.example/p.png';

    it.each(['still', 'original'] as const)('is never drawn, at prefer %s', (prefer) => {
      const { container } = render(MediaThumb, { item: item({ data: BEACON }), prefer });
      expect(container.querySelector('img')).toBeNull();
      expect(container.innerHTML).not.toContain('logger.attacker.example');
    });

    it('nor is a protocol-relative or http one', () => {
      for (const data of ['//logger.attacker.example/p.png', 'http://logger.attacker.example/p']) {
        const { container } = render(MediaThumb, { item: item({ data }) });
        expect(container.querySelector('img'), data).toBeNull();
      }
    });

    it('falls through to the thumbnail, and the same URL in url still draws', () => {
      const withPoster = render(MediaThumb, {
        item: item({ data: BEACON, thumbnail: 'data:image/webp;base64,SMALL' }),
        prefer: 'original'
      });
      expect(withPoster.container.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/webp;base64,SMALL'
      );

      const hosted = render(MediaThumb, { item: item({ url: BEACON }), prefer: 'original' });
      expect(hosted.container.querySelector('img')?.getAttribute('src')).toBe(BEACON);
    });
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

  it('reads a clip past an hour the way Music reads a track (MICA-417)', () => {
    const long = render(MediaThumb, {
      item: item({ kind: 'video', thumbnail: 'https://x.test/p.jpg', duration_ms: 3_665_600 })
    });
    // Rounded to the second, then `formatDuration`: not "61:06".
    expect(long.getByText('1:01:06')).toBeTruthy();
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
   *
   * MICA-405: inside a control the control itself is the gate, so nothing interactive is
   * drawn inside it; standalone, the overlay is a real button.
   */
  describe('streamer mode', () => {
    const photo = item({ data: 'data:image/png;base64,AAA' });
    const other = item({ id: 2, data: 'data:image/png;base64,BBB' });

    /** Everything a screen reader or a tab key would treat as a control. */
    const INTERACTIVE = 'button, a[href], [role], [tabindex]';
    const descriptionOf = (element: Element) =>
      (element.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent?.trim())
        .join(' ');
    const state = (element: Element) =>
      element.querySelector('[data-streamer]')?.getAttribute('data-streamer');

    beforeEach(() => {
      setStreamerMode(false);
      currentApp.set({ id: 'home', props: {} });
    });

    it('does nothing when the mode is off', () => {
      const { container } = render(MediaThumb, { item: photo });
      const root = container.firstElementChild as HTMLElement;
      expect(root.hasAttribute('data-streamer')).toBe(false);
      expect(container.querySelector('img')?.classList.contains('blur-media')).toBe(false);
      expect(container.querySelector('button')).toBeNull();
    });

    describe('inside a button', () => {
      it('draws nothing interactive inside it, and describes the button instead', () => {
        setStreamerMode(true);
        const { getByTestId } = render(MediaThumbInButton, {
          item: photo,
          onopen: () => {},
          label: 'Open photo 1'
        });
        const opener = getByTestId('opener');
        expect(state(opener)).toBe('blurred');
        // Still an <img>: the mode hides, it does not withhold. The picture is the app's to
        // fetch either way (AGENTS.md §7), so a blur that dropped the element would be theatre.
        expect(opener.querySelector('img')?.getAttribute('src')).toBe(photo.data);
        expect(opener.querySelector('img')?.classList.contains('blur-media')).toBe(true);

        // The defect: a `role="button"` overlay inside the tile, a second tab stop.
        expect(opener.querySelectorAll(INTERACTIVE)).toHaveLength(0);
        // The tile keeps its own name and says what activating it will do now.
        expect(opener.getAttribute('aria-label')).toBe('Open photo 1');
        expect(descriptionOf(opener)).toBe('Tap to reveal');
        // The painted words are generated content, so no text node a name must contain.
        const painted = opener.querySelector('[data-reveal-label]');
        expect(painted?.getAttribute('data-reveal-label')).toBe('Tap to reveal');
        expect(painted?.textContent).toBe('');
        expect(painted?.closest('[aria-hidden="true"]')).not.toBeNull();
      });

      it('reveals on the first tap, which goes no further, and opens on the second', async () => {
        setStreamerMode(true);
        let opened = 0;
        const { getByTestId } = render(MediaThumbInButton, {
          item: photo,
          onopen: () => (opened += 1)
        });
        const opener = getByTestId('opener');

        await fireEvent.click(opener.querySelector('img')!);
        expect(state(opener)).toBe('revealed');
        expect(opener.querySelector('img')?.classList.contains('blur-media')).toBe(false);
        expect(opened, 'the reveal tap must not open the picture').toBe(0);
        // Revealed, the tile is an ordinary tile again: no description, no gate.
        expect(opener.hasAttribute('aria-describedby')).toBe(false);

        await fireEvent.click(opener.querySelector('img')!);
        expect(opened).toBe(1);
      });

      /**
       * Enter and Space on a focused native button dispatch a click at the button itself,
       * which jsdom does not synthesize — so this dispatches that click, `detail: 0` as the
       * browser sends it, after the key. The key alone must not be what reveals: the button
       * is the browser's to activate, and swallowing its keydown would leave Space's click
       * on keyup to land after the gate was gone.
       */
      it.each(['Enter', ' '])('reveals on %j and goes no further', async (key) => {
        setStreamerMode(true);
        let opened = 0;
        const { getByTestId } = render(MediaThumbInButton, {
          item: photo,
          onopen: () => (opened += 1)
        });
        const opener = getByTestId('opener');
        opener.focus();

        await fireEvent.keyDown(opener, { key });
        expect(state(opener)).toBe('blurred');
        await fireEvent.click(opener, { detail: 0 });
        expect(state(opener)).toBe('revealed');
        expect(opened, 'the reveal key must not open the picture').toBe(0);
        expect(document.activeElement, 'focus stays on the tile').toBe(opener);

        await fireEvent.click(opener, { detail: 0 });
        expect(opened).toBe(1);
      });

      it('gates every activation again once a reveal is undone', async () => {
        setStreamerMode(true);
        let opened = 0;
        const { getByTestId } = render(MediaThumbInButton, {
          item: photo,
          onopen: () => (opened += 1)
        });
        const opener = getByTestId('opener');
        await fireEvent.click(opener);
        expect(state(opener)).toBe('revealed');

        currentApp.set({ id: 'messages', props: {} });
        await Promise.resolve();
        expect(state(opener)).toBe('blurred');
        expect(descriptionOf(opener)).toBe('Tap to reveal');
        await fireEvent.click(opener);
        expect(opened).toBe(0);
        expect(state(opener)).toBe('revealed');
      });

      it('reveals the one still tapped, and any other activation reveals the rest', async () => {
        setStreamerMode(true);
        let opened = 0;
        const { getByTestId } = render(MediaThumbInButton, {
          item: photo,
          second: other,
          onopen: () => (opened += 1)
        });
        const opener = getByTestId('opener');
        const [first, second] = opener.querySelectorAll<HTMLElement>('[data-streamer]');
        expect(descriptionOf(opener)).toBe('Tap to reveal Tap to reveal');

        await fireEvent.click(first.querySelector('img')!);
        expect(first.getAttribute('data-streamer')).toBe('revealed');
        expect(second.getAttribute('data-streamer')).toBe('blurred');
        expect(descriptionOf(opener)).toBe('Tap to reveal');

        // The button itself, or the revealed still: nothing it holds may be acted on unseen.
        await fireEvent.click(first.querySelector('img')!);
        expect(second.getAttribute('data-streamer')).toBe('revealed');
        expect(opened).toBe(0);

        await fireEvent.click(opener);
        expect(opened).toBe(1);
      });

      it('leaves a click that belongs to a control nested inside alone', async () => {
        setStreamerMode(true);
        let opened = 0;
        let quoted = 0;
        const { getByTestId } = render(MediaThumbInButton, {
          item: photo,
          onopen: () => (opened += 1),
          onquote: () => (quoted += 1)
        });
        await fireEvent.click(getByTestId('quote'));
        expect(quoted).toBe(1);
        expect(opened).toBe(0);
        expect(state(getByTestId('opener'))).toBe('blurred');
      });

      it('returns the description it added, and keeps one the caller set', async () => {
        setStreamerMode(true);
        const { getByTestId, unmount } = render(MediaThumbInButton, {
          item: photo,
          onopen: () => {}
        });
        const opener = getByTestId('opener');
        opener.setAttribute(
          'aria-describedby',
          `caller ${opener.getAttribute('aria-describedby')}`
        );
        setStreamerMode(false);
        await Promise.resolve();
        expect(opener.getAttribute('aria-describedby')).toBe('caller');
        setStreamerMode(true);
        await Promise.resolve();
        expect(opener.getAttribute('aria-describedby')?.split(' ')[0]).toBe('caller');
        unmount();
      });
    });

    describe('inside a role="button" that handles its own keys', () => {
      it.each(['Enter', ' '])('reveals on %j and the card never sees it', async (key) => {
        setStreamerMode(true);
        let activated = 0;
        const { getByTestId } = render(MediaThumbInRoleButton, {
          item: photo,
          onactivate: () => (activated += 1)
        });
        const card = getByTestId('card');
        expect(card.querySelectorAll(INTERACTIVE)).toHaveLength(0);
        expect(descriptionOf(card)).toBe('Tap to reveal');

        await fireEvent.keyDown(card, { key });
        expect(state(card)).toBe('revealed');
        expect(activated, 'the reveal key must not act on the picture').toBe(0);

        await fireEvent.keyDown(card, { key });
        expect(activated).toBe(1);
      });

      it('reveals on a click and the card never sees it', async () => {
        setStreamerMode(true);
        let activated = 0;
        const { getByTestId } = render(MediaThumbInRoleButton, {
          item: photo,
          onactivate: () => (activated += 1)
        });
        const card = getByTestId('card');
        await fireEvent.click(card.querySelector('img')!);
        expect(state(card)).toBe('revealed');
        expect(activated).toBe(0);
        await fireEvent.click(card.querySelector('img')!);
        expect(activated).toBe(1);
      });
    });

    describe('standalone', () => {
      it('draws the reveal as a real button, the one control there', async () => {
        setStreamerMode(true);
        const { container, getByRole } = render(MediaThumb, { item: photo });
        const root = container.firstElementChild as HTMLElement;
        expect(root.getAttribute('data-streamer')).toBe('blurred');
        const button = getByRole('button', { name: 'Tap to reveal' });
        expect(button.tagName).toBe('BUTTON');
        expect(button.getAttribute('type')).toBe('button');
        expect(container.querySelectorAll(INTERACTIVE)).toHaveLength(1);

        // A native button: Enter and Space reach it as this click.
        await fireEvent.click(button, { detail: 0 });
        expect(root.getAttribute('data-streamer')).toBe('revealed');
        expect(container.querySelector('button')).toBeNull();
      });
    });

    it('never blurs a placeholder, which has no picture to hide', () => {
      setStreamerMode(true);
      const { container } = render(MediaThumb, { item: item({ kind: 'audio' }) });
      expect((container.firstElementChild as HTMLElement).hasAttribute('data-streamer')).toBe(
        false
      );
      expect(container.querySelector('button')).toBeNull();
    });

    it('re-blurs a mounted thumb when the foreground app changes', async () => {
      setStreamerMode(true);
      const { container, getByRole } = render(MediaThumb, { item: photo });
      const root = container.firstElementChild as HTMLElement;
      await fireEvent.click(getByRole('button', { name: 'Tap to reveal' }));
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
