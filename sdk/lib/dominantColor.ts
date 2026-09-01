// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QuantizerCelebi, Score, hexFromArgb } from '@material/material-color-utilities';
import { loadImage } from './thumbnail';

/**
 * One colour out of a picture, for something else to build a theme from (MICA-111).
 *
 * The caller this exists for is the now-playing card, which is tinted from the album art.
 * What comes back is a **seed**, not a colour to paint with: it goes through
 * `buildSchemes` in `lib/m3.ts`, and every colour the card actually draws is an M3 role
 * out of that. That indirection is the whole safety story — M3's tonal palettes are
 * constructed so an `on-` role is legible against its surface, so a black album cover and
 * a white one both produce a readable card. Picking a colour off the image and painting
 * with it directly would make this module responsible for contrast, which it has no way
 * to guarantee.
 *
 * ## Quantize, then *score*
 *
 * `QuantizerCelebi` reduces the sampled pixels to a small palette with populations, and
 * `Score` ranks that palette for how well it would work as a UI theme colour — it is
 * MCU's own answer to this question and is what `themeFromImage` uses. `filter: true`
 * discards near-grayscale clusters and hues that appear too rarely to be the picture's
 * colour, which matters more here than it looks: an HCT hue derived from a desaturated
 * pixel is arbitrary, so a black-and-white cover scored without the filter yields a
 * confidently wrong hue (a flat `#101010` seed comes out cyan). Filtered, it yields
 * nothing, and nothing is what the caller wants — see the sentinel below.
 *
 * MCU's own `sourceColorFromImage` is close to this and is not used: it draws the image
 * at full size and, more to the point, sets no `crossOrigin`, so the canvas it reads back
 * from is tainted for exactly the remote artwork this is for.
 */

/**
 * `Score.score` always returns a colour — Google Blue when nothing in the image qualifies.
 * That default is indistinguishable from a genuinely blue album cover, so it is replaced
 * with a value the quantizer can never produce: every ARGB it emits is opaque, so nothing
 * with a zero alpha byte can come back from a real cluster.
 */
const NO_USABLE_COLOUR = 0x00000000;

/**
 * The longest edge the artwork is sampled at.
 *
 * The quantizer's cost is per pixel and the answer is a dominant colour, which does not
 * get more correct with more samples — 64px across a 320x180 YouTube thumbnail is ~2000
 * pixels, and the same picture at full size is 57,600 for the same answer. Small enough
 * that this runs synchronously inside one frame after the decode.
 */
const SAMPLE_MAX_DIMENSION = 64;

/** Clusters to reduce the sample to before scoring. MCU's own image path uses 128. */
const QUANTIZE_BUCKETS = 128;

/**
 * How long to wait for the artwork before giving up.
 *
 * Deliberately short. Nothing is broken while this is outstanding — the card is already
 * on screen in the phone's own colours and the tint arrives late or not at all — so the
 * only thing a longer timeout buys is a request held open against a host that, in CEF,
 * may never answer at all (`docs/testing-music-in-cef.md`).
 */
const ART_TIMEOUT_MS = 4000;

/**
 * Answers already worked out, keyed by URL — successes and failures alike.
 *
 * Both cards ask about the same artwork, the shade card is rebuilt on every pull of the
 * shade, and the answer for a given URL cannot change. Caching the failures matters as
 * much as caching the hits: if `img.youtube.com` is unreachable in game, or answers
 * without the CORS header, then it is unreachable for the whole session and retrying it
 * on every shade pull is a request per pull that can only fail again.
 *
 * Capped rather than unbounded. The entries are tiny, but a long session moves through a
 * lot of tracks and a cache with no eviction is a leak with a small constant.
 */
const answers = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();
const MAX_CACHED = 64;

const remember = (url: string, colour: string | null): string | null => {
  if (answers.size >= MAX_CACHED) {
    const oldest = answers.keys().next();
    if (!oldest.done) answers.delete(oldest.value);
  }
  answers.set(url, colour);
  return colour;
};

/** A seed is six hex digits and nothing else; `buildSchemes` is one call from `argbFromHex`. */
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The sampled pixels of an image, or `null` if the canvas will not give them up.
 *
 * `getImageData` throws `SecurityError` on a canvas tainted by a cross-origin draw, which
 * is the failure this whole module has to survive: the artwork is on YouTube's host, and
 * whether it answers with `Access-Control-Allow-Origin` from a `cfx-nui-` origin is an
 * open question in game. Everything in here is inside the try for that reason.
 */
const samplePixels = (img: HTMLImageElement): number[] | null => {
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!(w > 0) || !(h > 0)) return null;

  const scale = Math.min(1, SAMPLE_MAX_DIMENSION / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(img, 0, 0, w, h, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);

    const pixels: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      // Anything not fully opaque is skipped rather than composited against a guess: the
      // background it would be composited onto is the card, whose colour is what this is
      // being asked for.
      if (data[i + 3] < 255) continue;
      pixels.push((255 << 24) | (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }

    // Release the backing store now rather than at the next collection — same reasoning
    // as `releaseCanvas` in `thumbnail.ts`, on a path that runs once per track.
    canvas.width = 0;
    canvas.height = 0;

    return pixels.length ? pixels : null;
  } catch {
    return null;
  }
};

/**
 * The dominant colour of the image at `url` as `#rrggbb`, or `null`.
 *
 * **`null` is an ordinary answer, not an error.** A blocked host, a refused CORS
 * preflight, a tainted canvas, a decode that never finishes, a picture with no colour
 * worth calling dominant — every one of them lands here, and the caller's job is to draw
 * what it would have drawn anyway. Nothing in here rejects.
 *
 * `crossOrigin = 'anonymous'` on the load is **mandatory and is why this is a second
 * request rather than a read of the `<img>` already on screen**. Without it the canvas is
 * tainted the moment the artwork is drawn into it and `getImageData` throws
 * `SecurityError` — verified against `img.youtube.com` in this build, with the attribute
 * and without. It looks removable and is not. It is also the reason the *displayed*
 * `<img>` must not carry it: a `crossorigin` image whose host declines CORS fails to
 * render at all, which would trade a missing tint for a missing picture.
 */
export const dominantColorFrom = async (url: string): Promise<string | null> => {
  if (!url || typeof document === 'undefined') return null;

  const cached = answers.get(url);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(url);
  if (pending) return pending;

  const work = (async () => {
    try {
      const img = await loadImage(url, { timeoutMs: ART_TIMEOUT_MS, crossOrigin: 'anonymous' });
      const pixels = samplePixels(img);
      if (!pixels) return remember(url, null);

      const ranked = Score.score(QuantizerCelebi.quantize(pixels, QUANTIZE_BUCKETS), {
        desired: 1,
        fallbackColorARGB: NO_USABLE_COLOUR,
        filter: true
      });

      const best = ranked[0];
      if (best === undefined || best === NO_USABLE_COLOUR) return remember(url, null);

      const hex = hexFromArgb(best);
      return remember(url, HEX.test(hex) ? hex.toLowerCase() : null);
    } catch {
      return remember(url, null);
    } finally {
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, work);
  return work;
};

/** Test seam: the memo outlives a component, so a suite has to be able to empty it. */
export const resetDominantColorCacheForTest = (): void => {
  answers.clear();
  inFlight.clear();
};
