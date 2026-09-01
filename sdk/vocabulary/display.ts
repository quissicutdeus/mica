// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Theme, wallpaper and motion — the nouns `Facets['theme']`, `Facets['wallpaper']` and
 * `Facets['display']` are written in. MICA-172 — see `./accounts.ts`.
 *
 * These reached the SDK through `web/src/host/facets/theme.ts` and `.../wallpaper.ts`, which
 * only re-exported them from `shell/state/`. Two hops, one definition, and the package
 * depending on its consumer at both ends of the chain.
 */

export type ThemeMode = 'light' | 'dark';

export interface ThemeState {
  /** The color every role is generated from. `#rrggbb`. */
  seed: string;
  /**
   * Which of the two generated schemes is applied.
   *
   * `buildSchemes` has always produced both tables — light was generated and asserted
   * from the start precisely so switching it on would be this one union widening plus a
   * Settings control, rather than a change to the engine.
   */
  mode: ThemeMode;
}

/**
 * A wallpaper is a picked color, or a picture.
 *
 * This used to be three kinds — `preset` holding a Tailwind class string, `color` holding
 * a CSS color, `image` holding a `url(...)` shorthand — with the seed carried alongside
 * as a second, independent field. Three formats in one `value`, discriminated by `type`,
 * which forced `PhoneFrame` to decide between a `class` and a `style` for every render.
 */
export type WallpaperState = { type: 'color' } | { type: 'image'; image: string };

export interface WallpaperPreset {
  id: string;
  label: string;
  /** The color the whole phone — wallpaper included — is generated from. */
  seed: string;
}

/** Settings > Display > Motion. `system` defers to `prefers-reduced-motion`. */
export type MotionPreference = 'system' | 'full' | 'reduced';
