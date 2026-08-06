import { QuantizerCelebi, Score, hexFromArgb } from '@material/material-color-utilities';

/**
 * The dominant colour of a photo, as a theme seed.
 *
 * This is the one part of the colour system that touches the DOM, and it is a separate
 * module for exactly that reason: `lib/m3.ts` stays pure and fully unit-testable, and
 * nothing under test imports this. jsdom has no canvas — `getContext('2d')` returns
 * `null` — so a test that pulled this in through `m3.ts` would take the whole engine
 * suite down with it.
 *
 * MCU ships `sourceColorFromImage`, which is not used here. It quantizes every pixel of
 * the image at its natural size, and Celebi over a few million of them blocks the UI
 * thread. Drawing to a fixed 128x128 first bounds the cost regardless of what the camera
 * produced, and costs about ten lines.
 */

/** Enough pixels for the palette to be stable, few enough that Celebi is instant. */
const SAMPLE = 128;

/** A photo that will not decode must not hang the settings screen. */
const DECODE_TIMEOUT_MS = 5000;

const loadImage = (src: string): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(null), DECODE_TIMEOUT_MS);
    const settle = (result: HTMLImageElement | null) => {
      clearTimeout(timer);
      resolve(result);
    };

    image.onload = () => settle(image);
    image.onerror = () => settle(null);
    image.src = src;
  });

/**
 * Returns `#rrggbb`, or `null` if a seed could not be read.
 *
 * `null` is a real answer rather than a failure to report: the caller keeps whatever
 * seed is already set, which is a better outcome than a theme built from a colour we
 * guessed at.
 *
 * **`data:` URLs only.** Anything else — an `https://cfx-nui-…/` asset especially —
 * taints the canvas, and `getImageData` then throws a `SecurityError` rather than
 * returning something wrong. Refusing up front makes that a condition rather than an
 * exception. The phone's photo store holds base64 data URLs, so this is the whole of
 * what it is asked to read.
 */
export async function seedFromImage(source: string): Promise<string | null> {
  if (!source.startsWith('data:')) return null;

  const image = await loadImage(source);
  if (!image) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;

  const context = canvas.getContext('2d');
  if (!context) return null;

  context.drawImage(image, 0, 0, SAMPLE, SAMPLE);

  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, SAMPLE, SAMPLE).data;
  } catch {
    // Belt and braces: the `data:` check above should make this unreachable.
    return null;
  }

  const argb: number[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    // Skip anything meaningfully transparent — a padded or rounded image would
    // otherwise contribute a large block of whatever the empty pixels decode to.
    if (pixels[i + 3] < 255) continue;
    argb.push((255 << 24) | (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
  }
  if (argb.length === 0) return null;

  const counts = QuantizerCelebi.quantize(argb, 128);
  const ranked = Score.score(counts);

  return ranked.length > 0 ? hexFromArgb(ranked[0]) : null;
}
