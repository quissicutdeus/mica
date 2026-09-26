// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, type Writable } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import {
  DEFAULT_SEED,
  buildSchemes,
  cssVarBlock,
  sanitizeSeed
} from '../../../../sdk/host/seam/theme';
import type { M3Tokens } from '@mica/sdk';
import { ownerConfig } from './ownerConfig';

/**
 * The phone's active color theme.
 *
 * State the phone itself owns, so it lives here rather than in `services/` — there is no
 * server behind it and no table. Modeled on `display.ts`: exported constants, a
 * `usePersisted` store, derived views, and no DOM access.
 *
 * ## What replaced what
 *
 * `wallpaper.ts` used to derive theme colors by substring-matching Tailwind class
 * names — `if (value.includes('emerald'))`, and so on for three more. That could only
 * ever answer for the four presets somebody had written a branch for, and it answered
 * *wrongly* for two of them: the ocean preset contains `indigo-950` and matched the
 * `blue` branch by accident, and the sunset preset is
 * `from-purple-900 via-pink-900 to-rose-950` and matched `purple`, silently discarding
 * the pink and the rose. Anything unmatched returned an empty string, so the tokens fell
 * back to the shipped dark values — over a light wallpaper, unreadable text.
 *
 * The fix is not a longer list of branches. A theme is now generated from a seed color
 * by arithmetic (`lib/m3.ts`), so every seed works and none of them is a special case.
 */

import type { ThemeMode, ThemeState } from '@mica/sdk';

export const DEFAULT_THEME: ThemeState = { seed: DEFAULT_SEED, mode: 'dark' };

/**
 * A stored theme is a value a player can edit, and `argbFromHex` is one call away from
 * it — so this is narrow by design and never throws. An unrecognized mode falls back to
 * the shipped one rather than being preserved, because a mode nothing renders is worse
 * than the default.
 */
export const sanitizeTheme = (stored: unknown): ThemeState => {
  const s = (stored ?? {}) as Record<string, unknown>;
  return {
    seed: sanitizeSeed(s.seed),
    mode: s.mode === 'light' || s.mode === 'dark' ? s.mode : DEFAULT_THEME.mode
  };
};

/** What the player's own storage holds; the owner's default is laid over it below. */
const storedTheme = usePersisted<ThemeState>('settings', 'theme', DEFAULT_THEME, {
  sanitize: sanitizeTheme
});

/**
 * Whether the player ever picked a seed themselves (MICA-236). Needed because the stored
 * seed alone cannot say: a player who chose the shipped blue and one who never chose look
 * identical, and only the second should follow the owner's `themeSeed`.
 */
const seedChosen = usePersisted<boolean>('settings', 'themeSeedChosen', false, {
  sanitize: (stored) => stored === true
});

/**
 * The theme in effect: the player's own, with the owner's `themeSeed` standing in for a seed
 * the player never chose. Overlaid with `derived` and never written into storage, so an
 * owner changing the colour later still reaches everyone who has not picked one, and a
 * player's own pick survives it. A stored seed other than the shipped one predates the flag
 * and can only have been chosen.
 */
const effectiveTheme = derived(
  [storedTheme, seedChosen, ownerConfig],
  ([$stored, $chosen, $owner]): ThemeState => {
    const followsOwner = !$chosen && $stored.seed === DEFAULT_SEED && $owner.themeSeed;
    return followsOwner ? { ...$stored, seed: sanitizeSeed($owner.themeSeed) } : $stored;
  }
);

/**
 * Reads the effective theme; a write is the player's, and a write that moves the seed marks
 * it chosen. `update` goes through `set`, so a mode toggle never counts as choosing a seed.
 */
export const themeStore: Writable<ThemeState> = {
  subscribe: effectiveTheme.subscribe,
  set(next) {
    if (next.seed !== get(effectiveTheme).seed) seedChosen.set(true);
    storedTheme.set(next);
  },
  update(fn) {
    themeStore.set(fn(get(effectiveTheme)));
  }
};

export const setThemeSeed = (seed: string) =>
  themeStore.update((current) => ({ ...current, seed }));

export const setThemeMode = (mode: ThemeMode) =>
  themeStore.update((current) => ({ ...current, mode }));

/** Back to the shipped theme, and to following the owner's seed again. */
export const resetTheme = () => {
  seedChosen.set(false);
  storedTheme.set(DEFAULT_THEME);
};

/** Whether the light scheme is showing, for a toggle to bind to. */
export const isLightMode = derived(themeStore, ($theme) => $theme.mode === 'light');

/** The 47 resolved token values for the active seed and mode. */
export const schemeStore = derived(
  themeStore,
  ($theme): M3Tokens => buildSchemes($theme.seed)[$theme.mode]
);

/**
 * The tokens as a `style` attribute value.
 *
 * `PhoneFrame` writes this onto the phone screen element, where the custom properties
 * inherit into every app. The name is unchanged from the store this replaced, so the
 * consumer's import path moved and nothing else did.
 */
export const themeStyleStore = derived(schemeStore, cssVarBlock);
