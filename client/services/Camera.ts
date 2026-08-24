import { PhoneCamera } from '../game/PhoneCamera';

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
      // silently downscales anything bigger before gPhone ever sees it — on a monitor
      // wider than that (an ultrawide most of all, since its height is often still under
      // 1080) the whole frame gets shrunk well below native, and the phone's viewfinder
      // crop is a small fraction of that already-shrunk frame. Passing the real screen
      // resolution here is what actually fixes that; `computeCropGeometry` in
      // `apps/camera/capture.ts` still caps the *stored* crop's long edge at 1080px on
      // its own, so this does not change output size for anyone at or under 1080p.
      const [screenWidth, screenHeight] = GetActiveScreenResolution();
      exports['screencapture'].requestScreenshot(
        { encoding: 'png', maxWidth: screenWidth, maxHeight: screenHeight },
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
