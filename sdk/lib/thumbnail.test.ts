// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import {
  computeThumbnailSize,
  encodeCanvas,
  loadImage,
  makeThumbnail,
  releaseCanvas,
  thumbnailFromImage,
  THUMBNAIL_MAX_DIMENSION,
  THUMBNAIL_QUALITY
} from './thumbnail';

/**
 * The camera's own numbers, restated rather than imported: `lib/` may not import an app,
 * and the relationships below are exactly what would go unnoticed if one side moved.
 */
/** The default `gphone_camera_quality`; a server owner may set it lower. */
const CAPTURE_QUALITY = 0.95;
const CAPTURE_MAX_DIMENSION = 1080;

/**
 * MICA-110. Every photo is now stored twice — the original in `data` and a small copy in
 * `thumbnail` — because the gallery was pulling whole originals down the NUI bridge to
 * draw 123px squares. The maths is the half nobody can eyeball: a thumbnail that is
 * subtly the wrong shape looks fine in a square tile with `object-cover` and is wrong
 * everywhere else it is reused.
 */
describe('thumbnail geometry', () => {
  it('caps the longer edge, whichever edge that is', () => {
    // Portrait, the PHOTO-mode case: height is the long edge.
    expect(computeThumbnailSize(607, 1080)).toEqual({ width: 180, height: 320 });
    // Landscape, live since MICA-79: width is, and the same rule has to apply.
    expect(computeThumbnailSize(1080, 608)).toEqual({ width: 320, height: 180 });
  });

  it('keeps the photo aspect rather than cropping square', () => {
    // The tile is `aspect-square` and CSS crops it with `object-cover` — the same way it
    // already crops a row that has no thumbnail and falls back to `data`. Cropping here
    // would make those two paths frame differently in one gallery.
    for (const [w, h] of [
      [1080, 608],
      [607, 1080],
      [900, 900],
      [1600, 400]
    ]) {
      const size = computeThumbnailSize(w, h)!;
      expect(size.width / size.height).toBeCloseTo(w / h, 1);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(THUMBNAIL_MAX_DIMENSION);
    }
  });

  it('is a ceiling, not a target — it never upscales', () => {
    // The same rule as MICA-77 on the capture itself: the phone frequently renders
    // smaller than this, and stretching a small capture up is interpolation blur that
    // costs bytes to store. Re-encoding at thumbnail quality still shrinks it.
    expect(computeThumbnailSize(150, 150)).toEqual({ width: 150, height: 150 });
    expect(computeThumbnailSize(240, 100)).toEqual({ width: 240, height: 100 });
  });

  it('never rounds an extreme aspect down to nothing', () => {
    // A 1600x40 crop scales its short edge to 8. Rounding is what would make it 0, and a
    // canvas of width or height 0 encodes to `data:,`.
    const size = computeThumbnailSize(1600, 40)!;
    expect(size.width).toBe(320);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });

  it('returns null rather than a degenerate size for an image with no intrinsic size', () => {
    expect(computeThumbnailSize(0, 0)).toBeNull();
    expect(computeThumbnailSize(320, 0)).toBeNull();
    expect(computeThumbnailSize(Number.NaN, 320)).toBeNull();
  });

  /**
   * The reason the number is 320 and not the 123px the grid actually draws. Both figures
   * are restated here rather than imported: `MAX_SCALE` lives in `shell/state/display.ts`
   * and an app may not import out of its own directory (`sdk/boundary.test.ts`), and the
   * tile size is a CSS measurement with no constant behind it at all. So this is a floor
   * on the ceiling — it catches someone trimming 320 to fit the tile as drawn, which is
   * the specific mistake this size exists to avoid.
   */
  it('leaves headroom above the tile the grid actually draws', () => {
    const GRID_TILE_CSS_PX = 123; // three columns across a 400px screen
    const MAX_DISPLAY_ZOOM = 1.4; // Settings > Display, `MAX_SCALE`

    expect(THUMBNAIL_MAX_DIMENSION).toBeGreaterThanOrEqual(GRID_TILE_CSS_PX * 2);
    expect(THUMBNAIL_MAX_DIMENSION).toBeGreaterThanOrEqual(
      GRID_TILE_CSS_PX * MAX_DISPLAY_ZOOM * 1.5
    );
    // And still far below the original, or storing both would be pointless.
    expect(THUMBNAIL_MAX_DIMENSION).toBeLessThan(CAPTURE_MAX_DIMENSION / 3);
  });

  it('encodes cheaper than the original, through the same encoder', () => {
    // Measured through libwebp on a detail-dense 607x1080 plate: 21.4KB at 0.95 against
    // 4.5KB at 0.70 for the same 320px thumbnail. The original's own encode is untouched.
    expect(THUMBNAIL_QUALITY).toBeLessThan(CAPTURE_QUALITY);
    expect(THUMBNAIL_QUALITY).toBeGreaterThanOrEqual(0.6);

    const canvas = {
      toDataURL: vi.fn(
        (type: string) => `data:${type === 'image/webp' ? type : 'image/png'};base64,AAAA`
      )
    } as unknown as HTMLCanvasElement;

    expect(encodeCanvas(canvas, THUMBNAIL_QUALITY)).toMatch(/^data:image\/webp/);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', THUMBNAIL_QUALITY);
    // And the capture's own encode is untouched: same encoder, its own quality.
    encodeCanvas(canvas, CAPTURE_QUALITY);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', CAPTURE_QUALITY);
  });

  it('gives up on an image with no intrinsic size instead of throwing', () => {
    // jsdom has no 2D context, so this is the guard before the canvas — which is also the
    // case that matters: an engine reporting no natural size for a data URI must cost the
    // photo its thumbnail, not the shutter press.
    expect(
      thumbnailFromImage({ naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement)
    ).toBeNull();
  });

  it('resolves to null when the image never loads, rather than hanging the shutter', async () => {
    vi.useFakeTimers();
    try {
      const pending = makeThumbnail('data:image/webp;base64,AAAA');
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a load that neither succeeds nor errors', async () => {
    await expect(loadImage('data:image/webp;base64,AAAA', { timeoutMs: 5 })).rejects.toThrow();
  });
});

/**
 * A capture allocates two canvases and decodes one full-size image, and it happens once
 * per shutter press for as long as a player keeps shooting. Neither of these is visible
 * in an assertion about pixels, which is why they get their own.
 */
describe('what a capture leaves behind', () => {
  it('releases a canvas backing store rather than waiting for collection', () => {
    // Four bytes a pixel: a 508x1080 crop is 2.2MB that a dropped reference alone does
    // not free, because the backing store is not on the JS heap.
    const canvas = { width: 508, height: 1080 } as HTMLCanvasElement;
    releaseCanvas(canvas);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('clears the load timeout once the image has loaded', () => {
    // Left pending, the timer holds its closure — and through it the decoded full-size
    // bitmap — alive for the whole timeout after the image is already in hand.
    vi.useFakeTimers();
    const RealImage = globalThis.Image;
    try {
      class FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 400;
        naturalHeight = 850;
        set src(_value: string) {
          this.onload?.();
        }
      }
      globalThis.Image = FakeImage as unknown as typeof Image;

      const loaded = loadImage('data:image/webp;base64,AAAA', { timeoutMs: 3000 });
      expect(vi.getTimerCount()).toBe(0);
      return expect(loaded).resolves.toBeInstanceOf(FakeImage);
    } finally {
      globalThis.Image = RealImage;
      vi.useRealTimers();
    }
  });
});
