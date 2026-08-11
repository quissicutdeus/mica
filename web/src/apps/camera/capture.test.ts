import { describe, it, expect, vi } from 'vitest';
import {
  asDataUri,
  encodeCrop,
  CAPTURE_QUALITY,
  CAPTURE_WIDTH,
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
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', CAPTURE_QUALITY);
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

  it('asks for high quality — this is the only lossy step left', () => {
    const canvas = canvasThatSupports(['image/webp']);
    encodeCrop(canvas);
    expect(CAPTURE_QUALITY).toBeGreaterThanOrEqual(0.92);
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
   * source crop taken from the screenshot — genuinely differ in size.
   */
  it('outputs the same fixed width regardless of the rect the phone happened to be scaled to', () => {
    const small = computeCropGeometry(
      { left: 40, top: 60, width: 200, height: 400 },
      1000,
      800,
      1000,
      800
    );
    const large = computeCropGeometry(
      { left: 80, top: 120, width: 400, height: 800 },
      1000,
      800,
      1000,
      800
    );

    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(small!.outWidth).toBe(CAPTURE_WIDTH);
    expect(large!.outWidth).toBe(CAPTURE_WIDTH);
    // Same aspect ratio in, so the same output height — a uniform scale() changes width
    // and height by the same factor, which this fix relies on rather than works around.
    expect(small!.outHeight).toBe(large!.outHeight);
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

  it('follows the crop aspect ratio for the output height', () => {
    const geometry = computeCropGeometry(
      { left: 0, top: 0, width: 100, height: 200 },
      1000,
      800,
      1000,
      800
    );
    expect(geometry!.outHeight).toBe(Math.round(CAPTURE_WIDTH * 2));
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
