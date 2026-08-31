// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import NowPlayingCard from './NowPlayingCard.svelte';
import {
  cycleRepeat,
  musicError,
  musicHasNext,
  musicHasPrevious,
  musicNowPlaying,
  musicPosition,
  musicRepeat,
  musicShuffle,
  musicSource,
  musicStatus,
  nextTrack,
  pauseMusic,
  playSource,
  previousTrack,
  resetMusicForTest,
  resumeMusic,
  reportNowPlaying,
  seekMusic,
  stopMusic,
  toggleShuffle
} from '../../shell/state/music';

/**
 * MICA-111: the one now-playing card, and the album-art tint on it.
 *
 * The card itself is covered where it is used — `shell/NowPlaying.test.ts` for the shade
 * and `apps/music/index.test.ts` for the app, which is also what would catch the two
 * drifting apart again. What is left for here is the tint, because it is the part with a
 * failure mode nothing else would notice: it can go wrong by being *absent*, in a build
 * where every test still passes and every card is simply the colour it used to be.
 *
 * A store bundle rather than `useMusic()` on purpose — this is exactly what the shell
 * hands the card, so building it here is also a check that the shape is satisfiable
 * without a host.
 */
const stores = {
  musicSource,
  musicStatus,
  musicNowPlaying,
  musicError,
  musicPosition,
  musicRepeat,
  musicShuffle,
  musicHasNext,
  musicHasPrevious,
  seekMusic,
  cycleRepeat,
  toggleShuffle,
  nextTrack,
  previousTrack,
  pauseMusic,
  resumeMusic,
  stopMusic
};

const VIDEO = 'dQw4w9WgXcQ';

/** The extraction is the camera-and-canvas half; `dominantColor.test.ts` owns it. */
const dominant = vi.hoisted(() => vi.fn<(url: string) => Promise<string | null>>());
vi.mock('../lib/dominantColor', () => ({ dominantColorFrom: dominant }));

beforeEach(() => {
  resetMusicForTest();
  dominant.mockReset();
});

/** Render, let the extraction settle, and hand back the card element. */
const card = async (): Promise<HTMLElement> => {
  const { findByTestId } = render(NowPlayingCard, { props: { music: stores } });
  const el = await findByTestId('now-playing-card');
  await Promise.resolve();
  await tick();
  return el;
};

describe('the album-art tint', () => {
  it('re-themes the card from the artwork, in M3 roles rather than picked colours', async () => {
    dominant.mockResolvedValue('#b3261e');
    playSource(`https://youtu.be/${VIDEO}`);

    const style = (await card()).getAttribute('style') ?? '';

    // The whole role set, not one background: that is what makes the text on a tinted card
    // legible without this component reasoning about contrast at all.
    expect(style).toContain('--color-surface-container-low:');
    expect(style).toContain('--color-on-surface:');
    expect(style).toContain('--color-primary-container:');

    // A red cover has to move the card off the phone's own blue.
    const surface = /--color-surface-container-low:\s*rgb\((\d+), (\d+), (\d+)\)/.exec(style);
    expect(surface).toBeTruthy();
    const [r, , b] = surface!.slice(1).map(Number);
    expect(r).toBeGreaterThan(b);
  });

  /**
   * CEF is Chromium 103. `lib/m3.ts` composites every state layer numerically for exactly
   * this reason, and these values never pass through PostCSS — they go straight into a
   * `style` attribute — so a `color-mix()` or an `oklch()` reaching this string would
   * render as nothing in game and perfectly in the dev browser.
   */
  it('emits only colours CEF 103 can parse', async () => {
    dominant.mockResolvedValue('#2e7d32');
    playSource(`https://youtu.be/${VIDEO}`);

    const style = (await card()).getAttribute('style') ?? '';
    expect(style).not.toMatch(/color-mix|okl(ab|ch)|light-dark/);
    for (const [, value] of style.matchAll(/--color-[a-z-]+:\s*([^;]+)/g)) {
      expect(value.trim()).toMatch(/^rgba?\(/);
    }
  });

  it('picks the scheme that matches the phone, not always the dark one', async () => {
    dominant.mockResolvedValue('#b3261e');
    playSource(`https://youtu.be/${VIDEO}`);

    const { findByTestId } = render(NowPlayingCard, {
      props: { music: stores, mode: 'light' as const }
    });
    const el = await findByTestId('now-playing-card');
    await Promise.resolve();
    await tick();

    const surface = /--color-surface-container-low:\s*rgb\((\d+), (\d+), (\d+)\)/.exec(
      el.getAttribute('style') ?? ''
    );
    // A light scheme's surface is near-white; the dark one's is near-black. Anything that
    // silently pinned the mode would fail here rather than in a screenshot nobody takes.
    expect(Number(surface![1])).toBeGreaterThan(200);
  });

  /**
   * The degrade path, and the one that matters most: in game the artwork host may be
   * unreachable, or may answer without the CORS header that keeps the canvas readable. A
   * card that lost its colours entirely because the tint failed would be a far worse trade
   * than a card that is simply the phone's own colour.
   */
  it('leaves the card exactly as it was when the artwork gives up nothing', async () => {
    dominant.mockResolvedValue(null);
    playSource(`https://youtu.be/${VIDEO}`);

    const el = await card();
    expect(el.getAttribute('style') ?? '').toBe('');
    // Still a card, still the phone's own roles, still every control.
    expect(el.className).toContain('bg-surface-container-low');
    expect(el.querySelectorAll('button').length).toBeGreaterThan(3);
  });

  it('survives an extraction that throws rather than resolving', async () => {
    dominant.mockRejectedValue(new Error('canvas is tainted'));
    playSource(`https://youtu.be/${VIDEO}`);

    const el = await card();
    expect(el.getAttribute('style') ?? '').toBe('');
  });

  /**
   * The displayed cover must **not** carry `crossorigin`: a host that declines CORS would
   * then render no picture at all. The tint's own request is a second, anonymous one —
   * `dominantColor.ts` explains the asymmetry, and this is what stops somebody tidying it
   * into one attribute on the `<img>`.
   */
  it('draws the cover without asking the host for CORS permission to show it', async () => {
    dominant.mockResolvedValue('#b3261e');
    playSource(`https://youtu.be/${VIDEO}`);
    reportNowPlaying({ title: 'Never Gonna Give You Up', videoId: VIDEO });

    const img = (await card()).querySelector('img');
    expect(img?.getAttribute('src')).toContain(VIDEO);
    expect(img?.hasAttribute('crossorigin')).toBe(false);
  });

  it('asks about the artwork once per card, by its URL', async () => {
    dominant.mockResolvedValue('#b3261e');
    playSource(`https://youtu.be/${VIDEO}`);

    await card();
    expect(dominant).toHaveBeenCalledTimes(1);
    expect(dominant.mock.calls[0][0]).toContain(VIDEO);
  });
});
