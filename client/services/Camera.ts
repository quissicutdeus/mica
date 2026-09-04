// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PhoneCamera } from '../game/PhoneCamera';

/**
 * Upper bound on the intermediate capture's long edge, in pixels.
 *
 * Trades capture cost against viewfinder sharpness: full native resolution on a big or
 * ultrawide monitor froze the game for seconds while PNG-encoding the frame, and the
 * stored crop is capped at 1080px on its long edge downstream anyway.
 */
const CAPTURE_LONG_EDGE_MAX = 2560;

const takePhoto = async (): Promise<string> => {
  return new Promise((resolve, reject) => {
    try {
      // `screencapture:requestScreenshot` uses CBT to convert directly to base64 encoding.
      // https://github.com/itschip/screencapture?tab=readme-ov-file#requestscreenshot-client-side-export
      //
      // PNG, deliberately, even though nothing stores a PNG.
      //
      // This image is an intermediate: the NUI crops it to the viewfinder and re-encodes.
      // Asking for a JPEG here meant two lossy passes over the same pixels, and the
      // second one amplifies the first — JPEG's artefacts are exactly the kind of
      // high-frequency detail the next encoder then spends its bit budget preserving.
      // Dark sky gradients, which this game is full of, showed it worst.
      //
      // PNG makes the intermediate lossless, so the single remaining encode in the NUI
      // sees the original pixels. It costs a larger one-off NUI message; the frame is
      // discarded immediately and only the crop is ever stored.
      //
      // maxWidth/maxHeight: screencapture's own capture step defaults to 1920x1080 and
      // silently downscales anything bigger before micaOS ever sees it — on a monitor
      // wider than that (an ultrawide most of all, since its height is often still under
      // 1080) the whole frame gets shrunk well below native, and the phone's viewfinder
      // crop is a small fraction of that already-shrunk frame.
      //
      // The fix is to raise that ceiling, but not all the way to native: capturing and
      // PNG-encoding a full 5120px-wide frame stalls the game for seconds. So the long
      // edge is clamped to CAPTURE_LONG_EDGE_MAX with the aspect ratio preserved —
      // maxWidth/maxHeight is a bounding box screencapture downscales to fit, so this is
      // purely a lower ceiling and never a crop or a stretch. Well above the old 1920x1080
      // default, so viewfinder crops stay far sharper, and cheap enough not to freeze.
      //
      // `computeCropGeometry` in `apps/camera/capture.ts` still caps the *stored* crop's
      // long edge at 1080px on its own, so none of this changes output size.
      const [screenWidth, screenHeight] = GetActiveScreenResolution();
      const captureScale = Math.min(1, CAPTURE_LONG_EDGE_MAX / Math.max(screenWidth, screenHeight));
      exports['screencapture'].requestScreenshot(
        {
          encoding: 'png',
          maxWidth: Math.round(screenWidth * captureScale),
          maxHeight: Math.round(screenHeight * captureScale)
        },
        (data: string) => {
          resolve(data);
        }
      );
    } catch (error) {
      console.error('Failed to take photo with screencapture export:', error);
      reject(error);
    }
  });
};

RegisterNuiCallbackType('takePhoto');
on('__cfx_nui:takePhoto', async (_: any, cb: Function) => {
  try {
    const base64Data = await takePhoto();
    // Return the raw base64 data URI string
    cb(base64Data);
  } catch {
    // Return a dummy transparent pixel as fallback on failure
    cb(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    );
  }
});

/**
 * Front/rear camera toggle.
 *
 * Backed by the scripted camera, which is what made this implementable: the toggle is
 * the same cam re-attached with a different offset and spun 180 degrees.
 */
RegisterNuiCallbackType('flipCamera');
on('__cfx_nui:flipCamera', (data: { isFrontCamera?: boolean }, cb: Function) => {
  if (!PhoneCamera.isActive()) {
    cb({ supported: false });
    return;
  }

  PhoneCamera.setFrontFacing(Boolean(data?.isFrontCamera));
  cb({ supported: true, isFrontCamera: PhoneCamera.isFrontFacing() });
});

/**
 * Encoding quality for the stored photo, as a percentage.
 *
 * `mica_camera_quality`, and it needs `setr` — the NUI cannot read a convar at all, so
 * the value is read here and handed over. Replication is what makes that possible, the
 * same reason `mica_music_range` is a `setr` (README).
 *
 * The default is the number the encode was tuned at. It is worth turning down: measured
 * through libwebp on a detail-dense plate, 90 is roughly 30% fewer bytes for about a
 * decibel of PSNR, and every photo lives in `mediumtext` forever until MICA-71's
 * retention lands. Below about 80 the game's dark sky gradients start to band.
 */
const DEFAULT_CAMERA_QUALITY = 95;

/**
 * Clamp rather than reject.
 *
 * A convar is a free-form string, so `GetConvarInt` answers 0 for anything it cannot
 * parse — and 0 is a legal-looking number that would encode every photo as mud. Out of
 * range means the owner meant *something*, so the nearest usable value is a better answer
 * than silently shipping the garbage or silently ignoring them.
 */
export const cameraQuality = (): number => {
  const raw =
    typeof GetConvarInt === 'function'
      ? GetConvarInt('mica_camera_quality', DEFAULT_CAMERA_QUALITY)
      : DEFAULT_CAMERA_QUALITY;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CAMERA_QUALITY;
  return Math.min(100, Math.max(1, Math.round(raw)));
};

RegisterNuiCallbackType('cameraQuality');
on('__cfx_nui:cameraQuality', (_: any, cb: Function) => {
  cb({ quality: cameraQuality() });
});
