import { PhoneCameraController } from './PhoneCameraController';

const takePhoto = async (): Promise<string> => {
  return new Promise((resolve, reject) => {
    try {
      // `screencapture:requestScreenshot` uses CBT to convert directly to base64 encoding.
      // https://github.com/itschip/screencapture?tab=readme-ov-file#requestscreenshot-client-side-export
      //
      // Quality is explicit because the NUI re-encodes the crop, so whatever is lost
      // here is lost permanently and then compounded. The full-screen intermediate is
      // transient — only the crop is stored — so the extra bytes cost one NUI message.
      exports['screencapture'].requestScreenshot(
        { encoding: 'jpg', quality: 0.95 },
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
  } catch (e) {
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
  if (!PhoneCameraController.isActive()) {
    cb({ supported: false });
    return;
  }

  PhoneCameraController.setFrontFacing(Boolean(data?.isFrontCamera));
  cb({ supported: true, isFrontCamera: PhoneCameraController.isFrontFacing() });
});
