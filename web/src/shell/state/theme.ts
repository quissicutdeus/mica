import { derived } from 'svelte/store';
import { usePersisted } from '../../sdk/hooks/usePersisted';
import { DEFAULT_SEED, buildSchemes, cssVarBlock, sanitizeSeed, type M3Tokens } from '../../lib/m3';

/**
 * The phone's active colour theme.
 *
 * State the phone itself owns, so it lives here rather than in `services/` — there is no
 * server behind it and no table. Modelled on `display.ts`: exported constants, a
 * `usePersisted` store, derived views, and no DOM access.
 *
 * ## What replaced what
 *
 * `wallpaper.ts` used to derive theme colours by substring-matching Tailwind class
 * names — `if (value.includes('emerald'))`, and so on for three more. That could only
 * ever answer for the four presets somebody had written a branch for, and it answered
 * *wrongly* for two of them: the ocean preset contains `indigo-950` and matched the
 * `blue` branch by accident, and the sunset preset is
 * `from-purple-900 via-pink-900 to-rose-950` and matched `purple`, silently discarding
 * the pink and the rose. Anything unmatched returned an empty string, so the tokens fell
 * back to the shipped dark values — over a light wallpaper, unreadable text.
 *
 * The fix is not a longer list of branches. A theme is now generated from a seed colour
 * by arithmetic (`lib/m3.ts`), so every seed works and none of them is a special case.
 */

export interface ThemeState {
  /** The colour every role is generated from. `#rrggbb`. */
  seed: string;
  /**
   * Which of the two generated schemes is applied.
   *
   * Only `'dark'` today, and typed as a union of one on purpose: `buildSchemes` already
   * produces both tables, so turning light on is a change here and in a Settings toggle
   * rather than a change to the engine. Widening the union is the whole migration.
   */
  mode: 'dark';
}

export const DEFAULT_THEME: ThemeState = { seed: DEFAULT_SEED, mode: 'dark' };

/**
 * A stored theme is a value a player can edit, and `argbFromHex` is one call away from
 * it — so this is narrow by design and never throws. An unrecognised mode falls back to
 * dark rather than being preserved, because a mode nothing renders is worse than the
 * shipped one.
 */
export const sanitizeTheme = (stored: unknown): ThemeState => {
  const s = (stored ?? {}) as Record<string, unknown>;
  return {
    seed: sanitizeSeed(s.seed),
    mode: s.mode === 'dark' ? 'dark' : DEFAULT_THEME.mode
  };
};

export const themeStore = usePersisted<ThemeState>('settings', 'theme', DEFAULT_THEME, {
  sanitize: sanitizeTheme
});

export const setThemeSeed = (seed: string) =>
  themeStore.update((current) => ({ ...current, seed }));

export const resetTheme = () => themeStore.set(DEFAULT_THEME);

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
