// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Image encoding shared by the camera's capture and by every thumbnail made from one.
 *
 * It lives in `lib/` rather than in the camera app because two callers outside the camera
 * need it: the gallery, thumbnailing a photo that predates thumbnails, and the camera
 * itself through `@gos/sdk`. `lib/` is state-free and I/O-free by definition
 * (AGENTS.md §8), which is what makes it safe to re-export to a sandboxed add-on.
 */

/**
 * Encode a canvas, preferring WebP.
 *
 * At matching quality WebP is meaningfully smaller than JPEG and, more to the point, it
 * does not produce JPEG's 8x8 block edges. CEF's Chromium 103 can encode it.
 *
 * `toDataURL` silently falls back to PNG when it does not recognize the type, so the
 * result is checked rather than assumed: an unexpected PNG would be lossless but many
 * times larger, and every one of those goes into a database column.
 *
 * `quality` is required rather than defaulted, because the two callers want genuinely
 * different answers — the camera's own, which the server sets with
 * `gos_camera_quality` and defaults to 0.95, and `THUMBNAIL_QUALITY` for the small
 * copy — and a default would quietly make one of them wrong.
 */
/**
 * Drop a canvas's backing store now, rather than at the next collection.
 *
 * A capture allocates two of these — the crop at up to 508x1080 and the thumbnail — and a
 * 2D canvas's backing store is four bytes a pixel, so one photo is a little over 2MB of
 * bitmap that stays resident until the collector decides otherwise. A player taking fifty
 * photos in a sitting is a hundred megabytes of it, in a CEF instance shared with the
 * game.
 *
 * Resizing to 0 is the documented way to release it immediately; dropping the reference
 * alone is not, because the backing store is not on the JS heap. Defensive rather than a
 * measured fix — the accumulation is inferred from how canvases are allocated here, not
 * observed in game, and it costs two assignments to rule out.
 */
export const releaseCanvas = (canvas: HTMLCanvasElement): void => {
  canvas.width = 0;
  canvas.height = 0;
};

export const encodeCanvas = (canvas: HTMLCanvasElement, quality: number): string => {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', quality);
};

/**
 * The longest edge of the thumbnail written alongside every photo.
 *
 * A capture is stored twice now: the full `data` a player opens, and a small `thumbnail`
 * the gallery grid draws — because the grid was pulling every original down the NUI bridge
 * to fill 123px squares (MICA-110).
 *
 * 320 rather than something nearer the tile, and the reason is that "the tile" is not one
 * number:
 *
 * - The grid draws at **123 CSS px** today, three columns across a 400px screen.
 * - Settings > Display zooms the whole phone by up to `MAX_SCALE` (1.4), so the same tile
 *   is **172 device pixels** at the largest setting. A thumbnail cut to fit 123 would be
 *   visibly soft there, for a setting that has nothing to do with the camera — the same
 *   trap `CAPTURE_MAX_DIMENSION` exists to avoid.
 * - The phone itself is 400 CSS px wide, so 320 is within 1.25x of full-screen width. That
 *   makes the thumbnail usable as the placeholder the full view shows while the original
 *   is fetched, which is the third half of MICA-110 and the reason not to cut this
 *   number any finer.
 *
 * So: 2.6x the tile as drawn, 1.9x the tile at maximum zoom, and one number that still
 * works if the grid ever goes to two columns. It is a **ceiling, not a target** — see
 * `computeThumbnailSize`.
 */
export const THUMBNAIL_MAX_DIMENSION = 320;

/**
 * Quality for the thumbnail, and deliberately not the capture's.
 *
 * 0.95 is right for an original a player may open full-screen; at 320px it is mostly
 * wasted bytes. Measured through libwebp on a detail-dense 607x1080 plate: the same
 * thumbnail costs **21.4KB at 0.95 and 4.5KB at 0.70** — 4.7x the bytes for detail that
 * never reaches a 123px tile. Below about 0.6 the ringing starts to show on exactly the
 * dark gradients the game is full of, which is the other end of the range.
 *
 * The archival copy is untouched: `data` is still a single encode, at whatever
 * `gos_camera_quality` says (0.95 unless a server owner turned it down). This number
 * is fixed and does not follow it — the reasoning above is about a 123px tile, which is
 * 123px whatever the original was stored at.
 */
export const THUMBNAIL_QUALITY = 0.7;

/**
 * The thumbnail's pixel size — the photo's own aspect, longest edge capped.
 *
 * **Aspect kept, not cropped square.** The grid tile is `aspect-square` and `MediaThumb`
 * draws with `object-cover`, so CSS crops it for free and — this is the point — crops it
 * *identically* to the way it already crops a row that has no thumbnail and falls back to
 * `data`. Cropping here would make those two paths look different, in a gallery that will
 * hold both for as long as anyone's old photos survive. It also keeps the thumbnail
 * honest for the surfaces that are not square (the camera's own recent-capture tile, a
 * message attachment, a full-view placeholder), and it is *cheaper*: a 16:9 photo at 320
 * on the long edge is 320x180, against 320x320 for a square crop.
 *
 * **Never upscales**, for the same reason `computeCropGeometry` does not (MICA-77): the
 * phone often renders smaller than this ceiling, and stretching a small capture up is
 * interpolation blur that costs bytes to store. A source already under the cap is
 * re-encoded at thumbnail quality at its own size, which still shrinks it several times
 * over.
 */
export const computeThumbnailSize = (
  naturalWidth: number,
  naturalHeight: number
): { width: number; height: number } | null => {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;

  const longest = Math.max(naturalWidth, naturalHeight);
  const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / longest);

  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale))
  };
};

/**
 * Decode a data URI into an `<img>`, or reject.
 *
 * The timeout is the whole reason this is a function: an `Image` that neither loads nor
 * errors — a truncated payload, a data URI the engine will not touch — leaves the shutter
 * awaiting a promise that never settles, and the camera looks hung rather than broken.
 * Every caller here already had its own copy of this race.
 */
export const loadImage = (
  src: string,
  { timeoutMs, crossOrigin }: { timeoutMs: number; crossOrigin?: string }
): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    // Set before `src`, or it does not apply to the load this starts.
    if (crossOrigin) img.crossOrigin = crossOrigin;

    // Cleared on every settle path. A timer left pending holds this closure — and through
    // it the decoded full-size bitmap — alive for its whole duration after the image has
    // already loaded, which on the capture path is three seconds per photo.
    const timer = setTimeout(() => reject(new Error('Image load timeout')), timeoutMs);
    const settle = <T>(finish: (value: T) => void, value: T) => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      finish(value);
    };

    img.onload = () => settle(resolve, img);
    img.onerror = () => settle(reject, new Error('Image failed to load'));
    img.src = src;
  });

/**
 * Draw a loaded image down to thumbnail size and encode it.
 *
 * Returns `null` rather than throwing on anything it cannot do — no intrinsic size, a
 * canvas the engine refuses to read back — because a photo saved without a thumbnail is
 * recoverable and a shutter press that saves nothing is not.
 */
export const thumbnailFromImage = (img: HTMLImageElement): string | null => {
  const size = computeThumbnailSize(img.naturalWidth, img.naturalHeight);
  if (!size) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // A real downscale, so smoothing is not optional: off, this would alias every photo
    // whose size is not an exact multiple of the target — which, the cap being a ceiling
    // rather than a target, is nearly all of them.
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, size.width, size.height);

    const thumb = encodeCanvas(canvas, THUMBNAIL_QUALITY);
    releaseCanvas(canvas);
    return thumb && thumb.length > 30 && thumb !== 'data:,' ? thumb : null;
  } catch {
    return null;
  }
};

/**
 * The thumbnail for a finished capture.
 *
 * Derived from the **stored image**, not from the screenshot it was cut out of, so the
 * thumbnail is a picture of the photo rather than a second, independently-framed crop of
 * the world. That matters in LANDSCAPE, where the two are different shapes. It costs one
 * extra decode of an image the engine has just encoded, on a path that is already waiting
 * on a round trip.
 */
export const makeThumbnail = async (src: string): Promise<string | null> => {
  try {
    return thumbnailFromImage(await loadImage(src, { timeoutMs: 3000 }));
  } catch {
    return null;
  }
};
