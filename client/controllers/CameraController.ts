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
