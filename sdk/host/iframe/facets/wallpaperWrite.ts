// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['wallpaperWrite']>>;

/** Implementation of the `useWallpaperWrite` facet — see the inProcess twin for the usage contract. */
export function wallpaperWrite(): Twin {
  return {
    setWallpaperSeed: fn('wallpaperWrite', [], 'setWallpaperSeed'),
    setPresetWallpaper: fn('wallpaperWrite', [], 'setPresetWallpaper'),
    setWallpaperImage: fn('wallpaperWrite', [], 'setWallpaperImage'),
    resetWallpaper: fn('wallpaperWrite', [], 'resetWallpaper')
  };
}

registerFacet('wallpaperWrite', wallpaperWrite);
