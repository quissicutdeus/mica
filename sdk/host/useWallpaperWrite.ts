// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for changing the phone's home screen background (MICA-127) — a preset,
 * a color, or a photo. Separate from `useWallpaper()`, which only reads it.
 *
 * `setWallpaperImage` takes a CSS `url('…')` (or a bare source) whose source is an inline
 * image — a base64 `data:image/jpeg|png|webp|gif` URI — or an `https:` address, and **throws**
 * for anything else: another scheme, an empty source, a photo on the server's image host, or
 * a source carrying a quote, paren, backslash or whitespace (MICA-339). The value is rebuilt
 * from the vetted source rather than stored as passed, so it reaches the phone's style only
 * re-quoted; `shared/imageSource.ts` holds the rule.
 */
export function useWallpaperWrite() {
  return guarded('useWallpaperWrite').facets.wallpaperWrite();
}
