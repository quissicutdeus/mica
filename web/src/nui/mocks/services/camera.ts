// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sampleAvatars } from '../data';
import type { MockHandler } from '../registry';

let mockPhotoIndex = 5;

export const mocks: Record<string, MockHandler> = {
  // Camera & Media
  takePhoto: () => {
    const photo = sampleAvatars[mockPhotoIndex % sampleAvatars.length];
    mockPhotoIndex++;
    return photo;
  },
  flipCamera: async (data?: { isFrontCamera?: boolean }) => ({
    supported: true,
    isFrontCamera: !!data?.isFrontCamera
  }),
  // The default `mica_camera_quality`. A browser has no convars, so answering with the
  // number the client would answer with on an unconfigured server keeps the two paths
  // encoding the same bytes.
  cameraQuality: async () => ({ quality: 95 }),
  onCameraApp: async () => true
};
