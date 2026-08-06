import { describe, it, expect, vi } from 'vitest';
import { asDataUri, encodeCrop, CAPTURE_QUALITY } from './capture';

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
