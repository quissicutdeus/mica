const takePhoto = async (): Promise<string> => {
  return new Promise((resolve, reject) => {
    try {
      // `screencapture:requestScreenshot` uses CBT to convert directly to base64 encoding.
      // https://github.com/itschip/screencapture?tab=readme-ov-file#requestscreenshot-client-side-export
      exports['screencapture'].requestScreenshot({ encoding: 'jpg' }, (data: string) => {
        resolve(data);
      });
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
 * Front/rear camera toggle — **not implemented in game**.
 *
 * The web called this and nothing was registered, so the button silently did nothing
 * while the browser mock answered `true` and made it look fine in `pnpm dev`.
 *
 * A real selfie view is not a wiring fix: the in-game viewfinder is the world seen
 * through a transparent NUI, so "front camera" needs an actual `CreateCam` pointed at
 * the ped. Until that exists, answer honestly and let the UI hide the control rather
 * than offer one that does nothing.
 */
RegisterNuiCallbackType('flipCamera');
on('__cfx_nui:flipCamera', (_: any, cb: Function) => {
  cb({ supported: false });
});
