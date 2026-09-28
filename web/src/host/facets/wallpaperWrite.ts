// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { registerFacet } from '../../../../sdk/host/current';
import { isUnusableWallpaperImage } from '@mica/shared/hostedPhoto';
import { imageHostOrigin } from '../../services/imageHost';
import {
  setWallpaperSeed,
  setPresetWallpaper,
  setWallpaperImage,
  resetWallpaper
} from '../../shell/state/wallpaper';

/**
 * Implementation of the `useWallpaperWrite` facet — see the `useWallpaperWrite` hook doc
 * for the usage contract. Split out of `wallpaper` (MICA-127): reading the current
 * background and replacing the whole phone's are not the same ask.
 */
export function wallpaperWrite() {
  return {
    setWallpaperSeed,
    setPresetWallpaper,
    /**
     * Refuses, with an error, an image that is empty or is a photo on the image host
     * (MICA-293). A hosted photo has no bytes, so its wallpaper would be blank and its
     * colors could not be read without tainting the canvas; throwing beats setting nothing.
     */
    setWallpaperImage: (image: string, seed?: string) => {
      if (isUnusableWallpaperImage(image, get(imageHostOrigin))) {
        throw new Error(
          'That photo is stored on the image host and cannot be used as a wallpaper.'
        );
      }
      setWallpaperImage(image, seed);
    },
    resetWallpaper
  };
}

registerFacet('wallpaperWrite', wallpaperWrite);
