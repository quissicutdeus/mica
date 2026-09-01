// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// MICA-16 step 4: pulled out of `m3.ts` so the iframe theme twin can sanitize/convert a
// seed without pulling `@material/material-color-utilities` (and the rest of the color
// engine) into an add-on's bundle. Pure — no import here may reach back into `m3.ts`.

/** The seed the shipped theme is built from — see `m3.ts` for why this exact value. */
export const DEFAULT_SEED = '#155dfc';

/**
 * A seed is a six-digit hex color and nothing else.
 *
 * Narrow on purpose: this runs on a value read back from storage, which a player can
 * edit, and it is the only thing standing between that and the color engine. Three-digit
 * shorthand is rejected rather than expanded — the picker never produces it, so
 * accepting it would only widen what has to stay correct.
 */
export function sanitizeSeed(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : DEFAULT_SEED;
}

/**
 * A seed from the `rgba(r, g, b, a)` string `ColorWheelPicker` emits.
 *
 * The alpha is dropped rather than honored: a seed names a hue for the generator to
 * build tones from, and a translucent one has no meaning there. The wallpaper keeps the
 * alpha; the theme does not.
 */
export function seedFromRgbString(value: string): string | null {
  const match = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!match) return null;

  const hex = match
    .slice(1, 4)
    .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
    .join('');

  return `#${hex}`;
}
