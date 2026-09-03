// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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

import { encodeCanvas, releaseCanvas } from '@gos/sdk';

/**
 * Quality for the stored crop when the server has not said otherwise.
 *
 * The number the encode was tuned at, and the one `gos_camera_quality` defaults to.
 */
export const DEFAULT_CAPTURE_QUALITY = 0.95;

/**
 * The quality actually in force, as a 0-1 fraction.
 *
 * A module-level value rather than a store, because the only reader is `encodeCrop` and
 * it is called from a plain function, not from a component. Module scope outlives the
 * camera's component (the CEF page never unloads), so this survives the app closing and
 * is asked for again on foreground rather than on every shutter press.
 *
 * It starts at the default, so a capture taken before the client has answered — or on a
 * server that never set the convar, or in the browser — encodes at exactly the quality it
 * always did. There is no state in which this is undefined.
 */
let currentQuality = DEFAULT_CAPTURE_QUALITY;

/** What `encodeCrop` will use, for the tests and for anything that wants to report it. */
export const captureQuality = (): number => currentQuality;

/**
 * Adopt the server's number, or keep the default.
 *
 * The client clamps too, and this clamps again, because the value crosses the NUI bridge
 * as JSON and §2.9's reflex applies in both directions: a payload is a payload. A quality
 * of 0 is what `GetConvarInt` answers for an unparseable convar and would encode every
 * photo as mud, so anything outside 1-100 is refused rather than clamped to an edge — the
 * client already did the clamping for values a person plausibly meant.
 */
export const setCaptureQuality = (percent: unknown): number => {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 1 || percent > 100) {
    return currentQuality;
  }
  currentQuality = percent / 100;
  return currentQuality;
};

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
 * Encode the crop at capture quality.
 *
 * The encoder itself is `encodeCanvas` in `lib/thumbnail.ts` — shared, because the
 * thumbnail written beside every photo has to come out of the *same* one. Its WebP
 * preference and its checked fall back to JPEG rather than an accidental PNG matter more
 * for the small image than for the large one: a silent PNG thumbnail would be several
 * times the size of the photo's own encode at 320px.
 *
 * This wrapper is what keeps the quality here, in the camera, rather than in a module
 * about thumbnails. It reads `currentQuality` at call time rather than closing over it,
 * so a convar that arrives while the app is open applies to the next photo.
 */
export const encodeCrop = (canvas: HTMLCanvasElement): string =>
  encodeCanvas(canvas, currentQuality);

/**
 * The aspect ratio of the camera's LANDSCAPE frame.
 *
 * It is duplicated in CSS as `.aspect-video` in `app-utilities.css`, because the frame the
 * player composes through is laid out by the stylesheet while the browser mock's photo is
 * cut by the maths below — and the two must agree or the browser viewfinder frames one
 * thing and saves another. `capture.test.ts` reads the stylesheet and fails if they drift.
 */
export const LANDSCAPE_ASPECT = 16 / 9;

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CropGeometry {
  physX: number;
  physY: number;
  physWidth: number;
  physHeight: number;
  outWidth: number;
  outHeight: number;
}

/**
 * The output size every capture's longer edge is resampled to, when the source's longer
 * edge is already that big or bigger.
 *
 * `rect` comes from `containerRef.getBoundingClientRect()`, which reports **post-transform**
 * screen pixels — `Shell.svelte` draws the whole phone at a fixed 400x850 design size and
 * applies one `transform: scale()` on top of it (`shell/state/display.ts`), so the same
 * viewfinder measures differently depending on the Display setting alone. Before this, that
 * measurement became the output canvas's actual pixel size, so the same photo came out
 * sharper or softer depending on a setting that has nothing to do with the camera.
 *
 * Pinning the longer edge fixes the *resolution*, not the *framing* — the shorter edge
 * still follows the crop's own aspect ratio, which was never the problem: a uniform
 * `scale()` changes `rect.width` and `rect.height` by the same factor, so their ratio was
 * already scale-invariant. Only the absolute size floated.
 *
 * It is the longer edge specifically, not always the width, so this holds for a future
 * landscape crop too — the phone today is portrait (400x850), so the taller edge is the
 * one this caps; a wider-than-tall crop would cap on width instead, the same rule.
 *
 * This is a ceiling, not a target — `computeCropGeometry` never stretches a smaller
 * source up to it. The phone usually renders far smaller than 1080 physical pixels on its
 * long edge, and resampling that up is pure interpolation blur with no real detail behind
 * it.
 */
export const CAPTURE_MAX_DIMENSION = 1080;

/**
 * The crop math, pulled out so it can be tested without a real `<canvas>` — jsdom has no
 * `getContext('2d')` implementation, so `cropViewportToCanvas` itself is only exercised by
 * this function's return value up to the draw call.
 */
export const computeCropGeometry = (
  rect: CropRect,
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number
): CropGeometry | null => {
  if (!rect || rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return null;
  }

  const scaleX = naturalWidth / viewportWidth;
  const scaleY = naturalHeight / viewportHeight;

  const physX = Math.round(rect.left * scaleX);
  const physY = Math.round(rect.top * scaleY);
  const physWidth = Math.round(rect.width * scaleX);
  const physHeight = Math.round(rect.height * scaleY);

  if (physWidth <= 10 || physHeight <= 10) {
    return null;
  }

  let outWidth: number;
  let outHeight: number;
  if (physWidth >= physHeight) {
    outWidth = Math.min(CAPTURE_MAX_DIMENSION, physWidth);
    outHeight = Math.round(outWidth * (physHeight / physWidth));
  } else {
    outHeight = Math.min(CAPTURE_MAX_DIMENSION, physHeight);
    outWidth = Math.round(outHeight * (physWidth / physHeight));
  }

  return { physX, physY, physWidth, physHeight, outWidth, outHeight };
};

/**
 * Crop a raw full-screen image using natural dimensions and unscaled rect coordinates.
 */
export const cropViewportToCanvas = (
  img: HTMLImageElement,
  rect: CropRect,
  viewportWidth: number,
  viewportHeight: number
): string | null => {
  const geometry = computeCropGeometry(
    rect,
    img.naturalWidth,
    img.naturalHeight,
    viewportWidth,
    viewportHeight
  );
  if (!geometry) return null;
  const { physX, physY, physWidth, physHeight, outWidth, outHeight } = geometry;

  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Smoothing was off when this drew 1:1 (source and destination were the same size).
  // Resampling to a fixed output size makes this a real scale, and off would alias every
  // capture whose source size isn't an exact multiple of the target.
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, physX, physY, physWidth, physHeight, 0, 0, outWidth, outHeight);

  const cropped = encodeCrop(canvas);
  // The crop canvas is the big one — 508x1080 at four bytes a pixel — and nothing else
  // refers to it once the data URI exists. See `releaseCanvas`.
  releaseCanvas(canvas);
  return cropped && cropped.length > 30 && cropped !== 'data:,' ? cropped : null;
};

/**
 * The largest centred rect of a given aspect ratio that fits inside a source image.
 *
 * The in-game capture does not need this — there the crop rect is the on-screen box of the
 * frame the player composed through, so a landscape frame yields a landscape crop with no
 * further maths (`computeCropGeometry` already caps whichever edge is longer). The browser
 * mock has no world behind it and no meaningful geometry: it saves the viewfinder's
 * stand-in image whole, which would come out square in LANDSCAPE mode and quietly make the
 * dev viewfinder a liar. This cuts the stand-in to the same shape the frame drew.
 */
export const centerCropToAspect = (
  naturalWidth: number,
  naturalHeight: number,
  aspect: number
): CropRect | null => {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(aspect > 0)) return null;

  if (naturalWidth / naturalHeight > aspect) {
    // Wider than the target: keep the full height and trim the sides.
    const width = Math.round(naturalHeight * aspect);
    return { left: Math.round((naturalWidth - width) / 2), top: 0, width, height: naturalHeight };
  }

  // Taller than (or equal to) the target: keep the full width and trim top and bottom.
  const height = Math.round(naturalWidth / aspect);
  return { left: 0, top: Math.round((naturalHeight - height) / 2), width: naturalWidth, height };
};

/**
 * Centre-crop a loaded image to `aspect`, at its own resolution.
 *
 * Returns `null` rather than throwing on anything it cannot do — an image with no intrinsic
 * size (an SVG data URI carrying only a `viewBox` reports none in some engines), a canvas
 * the engine refuses to read back. Every caller falls back to the uncropped source, so the
 * worst case is the old behaviour rather than a photo that fails to save.
 */
export const cropImageToAspect = (img: HTMLImageElement, aspect: number): string | null => {
  const rect = centerCropToAspect(img.naturalWidth, img.naturalHeight, aspect);
  if (!rect || rect.width < 1 || rect.height < 1) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);

    const cropped = encodeCrop(canvas);
    releaseCanvas(canvas);
    return cropped && cropped.length > 30 && cropped !== 'data:,' ? cropped : null;
  } catch {
    return null;
  }
};
