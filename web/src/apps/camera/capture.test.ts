// @vitest-environment jsdom
//
// `capture.ts` reaches the shared image encoder through `@gphone/sdk` — an app may not
// import `lib/` by path (§2.7) — and the SDK barrel touches `window` at import time. The
// node default is deliberate and cheaper (see `web/vite.config.ts`); this is the opt-in
// that config describes, not a workaround. The thumbnail maths itself is tested in
// `src/lib/thumbnail.test.ts`, which stays on node because it imports nothing.
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asDataUri,
  encodeCrop,
  captureQuality,
  setCaptureQuality,
  DEFAULT_CAPTURE_QUALITY,
  CAPTURE_MAX_DIMENSION,
  LANDSCAPE_ASPECT,
  centerCropToAspect,
  computeCropGeometry
} from './capture';

/**
 * The capture pipeline had two lossy encodes where one would do. These cover the two
 * places that assumed a format instead of checking one.
 */

describe('asDataUri', () => {
  it('passes a full data URI through untouched', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    expect(asDataUri(uri)).toBe(uri);
  });

  it('labels bare PNG base64 as a PNG', () => {
    // The client now asks `screencapture` for a PNG. This was hard-coded to image/jpeg.
    expect(asDataUri('iVBORw0KGgoAAAANSUhEUg')).toMatch(/^data:image\/png;base64,iVBOR/);
  });

  it('still labels bare JPEG base64 as a JPEG', () => {
    // Some screencapture builds return a JPEG regardless of what was asked for.
    expect(asDataUri('/9j/4AAQSkZJRg')).toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe('encodeCrop', () => {
  const canvasThatSupports = (types: string[]) =>
    ({
      toDataURL: vi.fn(
        (type: string) => `data:${types.includes(type) ? type : 'image/png'};base64,AAAA`
      )
    }) as unknown as HTMLCanvasElement;

  it('encodes as WebP when the engine supports it', () => {
    const canvas = canvasThatSupports(['image/webp', 'image/jpeg']);
    expect(encodeCrop(canvas)).toMatch(/^data:image\/webp/);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', captureQuality());
  });

  it('falls back to JPEG rather than shipping the silent PNG', () => {
    // `toDataURL` returns a PNG for an unrecognised type instead of failing. A PNG here
    // would be lossless but many times larger, and every photo lands in a database
    // column — so the returned type is checked, not the call.
    const canvas = canvasThatSupports(['image/jpeg']);
    const out = encodeCrop(canvas);

    expect(out).toMatch(/^data:image\/jpeg/);
    expect(out).not.toMatch(/^data:image\/png/);
  });

  it('asks for high quality by default — this is the only lossy step left', () => {
    const canvas = canvasThatSupports(['image/webp']);
    encodeCrop(canvas);
    expect(DEFAULT_CAPTURE_QUALITY).toBeGreaterThanOrEqual(0.92);
  });

  it('encodes at the quality the server asked for', () => {
    setCaptureQuality(90);
    const canvas = canvasThatSupports(['image/webp']);
    encodeCrop(canvas);

    expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', 0.9);
    setCaptureQuality(DEFAULT_CAPTURE_QUALITY * 100);
  });
});

describe('setCaptureQuality', () => {
  // Restored after each case: the value is module scope on purpose (it outlives the
  // component), so a test that changed it would leak into every later one.
  const restore = () => setCaptureQuality(DEFAULT_CAPTURE_QUALITY * 100);

  it('takes a percentage and stores a fraction', () => {
    expect(setCaptureQuality(80)).toBeCloseTo(0.8, 10);
    expect(captureQuality()).toBeCloseTo(0.8, 10);
    restore();
  });

  it('keeps the current value for anything outside 1-100', () => {
    // 0 is the one that matters: `GetConvarInt` answers 0 for a convar it cannot parse,
    // and 0 would encode every photo as mud.
    for (const bad of [0, -5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(setCaptureQuality(bad)).toBe(DEFAULT_CAPTURE_QUALITY);
    }
    expect(captureQuality()).toBe(DEFAULT_CAPTURE_QUALITY);
  });

  it('keeps the current value for a reply that is not a number at all', () => {
    // The reply crosses the NUI bridge as JSON, and a missing field arrives as undefined.
    for (const bad of [undefined, null, '90', {}]) {
      expect(setCaptureQuality(bad)).toBe(DEFAULT_CAPTURE_QUALITY);
    }
  });
});

describe('cropViewportToCanvas', () => {
  it('returns null on invalid rect or viewport bounds', async () => {
    const { cropViewportToCanvas } = await import('./capture');
    const dummyImg = {} as HTMLImageElement;
    expect(
      cropViewportToCanvas(dummyImg, { left: 0, top: 0, width: 0, height: 100 }, 1000, 800)
    ).toBeNull();
  });
});

describe('computeCropGeometry', () => {
  /**
   * This is the fix for "camera capture resolution is tied to display scale"
   * (docs/roadmap.md): a viewfinder measured at two different `Shell.svelte` zoom levels
   * must resample to the *same* output size, even though its measured rect — and the
   * source crop taken from the screenshot — genuinely differ in size. Only holds once the
   * source is big enough to actually reach `CAPTURE_MAX_DIMENSION` without stretching.
   *
   * The phone is portrait (400x850), so these rects are all taller than they are wide —
   * height is the longer edge, and the one this ceiling actually pins.
   */
  it('outputs the same fixed height regardless of the rect the phone happened to be scaled to, once the source is big enough', () => {
    const small = computeCropGeometry(
      { left: 40, top: 60, width: 200, height: 400 },
      8000,
      6400,
      1000,
      800
    );
    const large = computeCropGeometry(
      { left: 80, top: 120, width: 400, height: 800 },
      8000,
      6400,
      1000,
      800
    );

    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(small!.outHeight).toBe(CAPTURE_MAX_DIMENSION);
    expect(large!.outHeight).toBe(CAPTURE_MAX_DIMENSION);
    // Same aspect ratio in, so the same output width — a uniform scale() changes width
    // and height by the same factor, which this fix relies on rather than works around.
    expect(small!.outWidth).toBe(large!.outWidth);
  });

  /**
   * A landscape-shaped crop (wider than tall) caps on width instead — the same rule,
   * applied to whichever edge is actually the longer one. Nothing wires a landscape crop
   * rect up today (the camera's LANDSCAPE mode button is a UI stub), but the geometry
   * itself must already handle one correctly rather than assuming portrait.
   */
  it('caps on width instead, for a landscape-shaped crop', () => {
    const geometry = computeCropGeometry(
      { left: 0, top: 0, width: 800, height: 400 },
      8000,
      4000,
      1000,
      500
    );

    expect(geometry).not.toBeNull();
    expect(geometry!.outWidth).toBe(CAPTURE_MAX_DIMENSION);
    expect(geometry!.outHeight).toBe(Math.round(CAPTURE_MAX_DIMENSION / 2));
  });

  /**
   * MICA-77: the phone usually renders far smaller on screen than 1080 physical
   * pixels on its long edge, and the old code resampled that tiny capture up to
   * `CAPTURE_MAX_DIMENSION` regardless — pure interpolation blur with no real detail
   * behind it. A source smaller than the ceiling must come out at its own size, not
   * stretched.
   */
  it('never upscales a source smaller than CAPTURE_MAX_DIMENSION', () => {
    const geometry = computeCropGeometry(
      { left: 0, top: 0, width: 150, height: 300 },
      300,
      600,
      300,
      600
    );

    expect(geometry).not.toBeNull();
    expect(geometry!.outHeight).toBe(300);
    expect(geometry!.outHeight).toBeLessThan(CAPTURE_MAX_DIMENSION);
    expect(geometry!.outWidth).toBe(150);
  });

  it('still reads the source crop from the rect actually measured, unscaled', () => {
    // The *content* captured must still track the real on-screen box — only the encoded
    // resolution is pinned. A screenshot at 2x the CSS viewport (device pixel ratio) scales
    // the source rect accordingly.
    const geometry = computeCropGeometry(
      { left: 10, top: 20, width: 100, height: 200 },
      2000,
      1600,
      1000,
      800
    );
    expect(geometry).toMatchObject({ physX: 20, physY: 40, physWidth: 200, physHeight: 400 });
  });

  it('follows the crop aspect ratio for the capped edge', () => {
    const geometry = computeCropGeometry(
      { left: 0, top: 0, width: 100, height: 200 },
      10800,
      8640,
      1000,
      800
    );
    expect(geometry!.outHeight).toBe(CAPTURE_MAX_DIMENSION);
    expect(geometry!.outWidth).toBe(Math.round(CAPTURE_MAX_DIMENSION / 2));
  });

  it('returns null on invalid rect or viewport bounds', () => {
    expect(
      computeCropGeometry({ left: 0, top: 0, width: 0, height: 100 }, 1000, 800, 1000, 800)
    ).toBeNull();
    expect(
      computeCropGeometry({ left: 0, top: 0, width: 100, height: 100 }, 1000, 800, 0, 800)
    ).toBeNull();
  });

  it('returns null for a crop too small to be a real photo', () => {
    expect(
      computeCropGeometry({ left: 0, top: 0, width: 1, height: 1 }, 1000, 800, 1000, 800)
    ).toBeNull();
  });
});

/**
 * MICA-79. The camera's LANDSCAPE mode reframes what the photo is cut from rather than
 * rotating the phone, so "is it really landscape?" is a question about geometry — which is
 * exactly the part nobody can check by looking at the viewfinder.
 */
describe('LANDSCAPE framing', () => {
  it('agrees with the .aspect-video rule the frame is actually laid out by', () => {
    // The frame's shape is CSS and the browser mock's crop is arithmetic. If they drift,
    // the dev viewfinder frames one shape and saves another — silently, and only in the
    // mode this whole feature is about.
    const webSrc = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const css = fs.readFileSync(path.join(webSrc, 'app-utilities.css'), 'utf8');
    const rule = /\.aspect-video\s*\{\s*aspect-ratio:\s*(\d+)\s*\/\s*(\d+)\s*;?\s*\}/.exec(css);

    expect(rule, '.aspect-video declared in app-utilities.css').not.toBeNull();
    expect(Number(rule![1]) / Number(rule![2])).toBeCloseTo(LANDSCAPE_ASPECT, 5);
    expect(LANDSCAPE_ASPECT).toBeGreaterThan(1);
  });

  it('turns the framed region into a genuinely wider-than-tall photo', () => {
    // The in-game path: the crop rect is the frame's own on-screen box, so a 16:9 frame
    // has to come out of `computeCropGeometry` still 16:9 and still landscape.
    const height = 225;
    const geometry = computeCropGeometry(
      { left: 0, top: 312, width: Math.round(height * LANDSCAPE_ASPECT), height },
      3840,
      2160,
      1920,
      1080
    );

    expect(geometry).not.toBeNull();
    expect(geometry!.outWidth).toBeGreaterThan(geometry!.outHeight);
    expect(geometry!.outWidth / geometry!.outHeight).toBeCloseTo(LANDSCAPE_ASPECT, 1);
  });

  describe('centerCropToAspect', () => {
    it('trims the top and bottom of a source taller than the target', () => {
      // The browser stand-in is a square SVG, which is this case.
      expect(centerCropToAspect(160, 160, LANDSCAPE_ASPECT)).toEqual({
        left: 0,
        top: 35,
        width: 160,
        height: 90
      });
    });

    it('trims the sides of a source wider than the target', () => {
      expect(centerCropToAspect(400, 100, LANDSCAPE_ASPECT)).toEqual({
        left: 111,
        top: 0,
        width: 178,
        height: 100
      });
    });

    it('keeps the crop centred, so the framing does not drift to one edge', () => {
      const rect = centerCropToAspect(1000, 1000, LANDSCAPE_ASPECT)!;
      expect(rect.top).toBe(Math.round((1000 - rect.height) / 2));
      // Equal margins top and bottom, to within the rounding of a whole pixel.
      expect(Math.abs(1000 - rect.height - 2 * rect.top)).toBeLessThanOrEqual(1);
    });

    it('never returns a crop larger than the source', () => {
      for (const [w, h] of [
        [160, 160],
        [400, 100],
        [1920, 1080],
        [7, 900]
      ]) {
        const rect = centerCropToAspect(w, h, LANDSCAPE_ASPECT)!;
        expect(rect.width).toBeLessThanOrEqual(w);
        expect(rect.height).toBeLessThanOrEqual(h);
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.top).toBeGreaterThanOrEqual(0);
      }
    });

    it('returns null rather than a degenerate rect for an image with no intrinsic size', () => {
      // An SVG data URI carrying only a `viewBox` reports no natural size in some engines.
      // The caller falls back to the uncropped image, which is the old behaviour.
      expect(centerCropToAspect(0, 0, LANDSCAPE_ASPECT)).toBeNull();
      expect(centerCropToAspect(160, 0, LANDSCAPE_ASPECT)).toBeNull();
      expect(centerCropToAspect(160, 160, 0)).toBeNull();
      expect(centerCropToAspect(Number.NaN, 160, LANDSCAPE_ASPECT)).toBeNull();
    });
  });
});
