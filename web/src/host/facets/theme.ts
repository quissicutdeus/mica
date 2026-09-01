// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { themeStore, schemeStore, isLightMode, DEFAULT_THEME } from '../../shell/state/theme';
import { seedFromRgbString, sanitizeSeed } from '../../../../sdk/host/seam/theme';

/**
 * Implementation of the `useTheme` facet — see the `useTheme` hook doc for the usage
 * contract. Read-only: changing the seed, the mode, or resetting either is `useThemeWrite`
 * (MICA-127) — a player picking a theme is a much bigger ask than an app rendering one.
 */
export function theme() {
  return {
    themeStore,
    schemeStore,
    isLightMode,
    defaultTheme: DEFAULT_THEME,
    /** Convert an `rgb()`/`rgba()` string — what a color picker emits — into a seed. */
    seedFromRgbString,
    sanitizeSeed
  };
}

/** @public — SDK surface for add-ons; no in-repo app needs to name it. */

registerFacet('theme', theme);
