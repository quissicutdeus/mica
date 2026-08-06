/**
 * Encoding for the camera's capture path.
 *
 * The pipeline is: `screencapture` grabs the whole screen → the NUI crops it to the
 * viewfinder → the crop is stored. Only the last step needs to be lossy, and for a long
 * time both were: the client asked for a JPEG and the NUI re-encoded it as another one.
 * Two passes over the same pixels, the second amplifying the first, worst on the dark
 * gradients the game is full of.
 *
 * The client now sends a lossless PNG, so everything here is the single encode.
 */

/** Quality for the stored crop. */
export const CAPTURE_QUALITY = 0.95;

/**
 * Wrap raw base64 in a data URI, naming the type from the payload's own magic bytes.
 *
 * `screencapture` returns a bare base64 string on some versions and a full data URI on
 * others. This used to hard-code `image/jpeg` for the bare case, which was true only for
 * as long as the client asked for a JPEG.
 */
export const asDataUri = (raw: string): string => {
  if (raw.startsWith('data:')) return raw;
  // `iVBOR` is base64 for the PNG signature's first bytes; `/9j/` is JPEG's SOI.
  const type = raw.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return `data:${type};base64,${raw}`;
};

/**
 * Encode the crop, preferring WebP.
 *
 * At matching quality WebP is meaningfully smaller than JPEG and, more to the point, it
 * does not produce JPEG's 8x8 block edges. CEF's Chromium 103 can encode it.
 *
 * `toDataURL` silently falls back to PNG when it does not recognise the type, so the
 * result is checked rather than assumed: an unexpected PNG would be lossless but many
 * times larger, and every one of those goes into a database column.
 */
export const encodeCrop = (canvas: HTMLCanvasElement): string => {
  const webp = canvas.toDataURL('image/webp', CAPTURE_QUALITY);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', CAPTURE_QUALITY);
};

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Crop a raw full-screen image using natural dimensions and unscaled rect coordinates.
 */
export const cropViewportToCanvas = (
  img: HTMLImageElement,
  rect: CropRect,
  viewportWidth: number,
  viewportHeight: number
): string | null => {
  if (!rect || rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return null;
  }

  const scaleX = img.naturalWidth / viewportWidth;
  const scaleY = img.naturalHeight / viewportHeight;

  const physX = Math.round(rect.left * scaleX);
  const physY = Math.round(rect.top * scaleY);
  const physWidth = Math.round(rect.width * scaleX);
  const physHeight = Math.round(rect.height * scaleY);

  if (physWidth <= 10 || physHeight <= 10) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = physWidth;
  canvas.height = physHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, physX, physY, physWidth, physHeight, 0, 0, physWidth, physHeight);

  const cropped = encodeCrop(canvas);
  return cropped && cropped.length > 30 && cropped !== 'data:,' ? cropped : null;
};
