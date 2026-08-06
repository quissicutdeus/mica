import { usePersisted } from '../../sdk/hooks/usePersisted';
import { setThemeSeed } from './theme';

export interface WallpaperState {
  type: 'preset' | 'color' | 'image';
  /**
   * A Tailwind class for a `preset`, a CSS colour for a `color`, or a `url(...)`
   * background shorthand for an `image`.
   */
  value: string;
}

/**
 * The wallpapers offered in Settings.
 *
 * These live here rather than in the pane that renders them because each one now
 * carries a **seed**, and the seed is theme state — the pane is one consumer of that,
 * not its owner.
 *
 * The seed is declared, never inferred. Inferring it from the class string is exactly
 * what the `themeStyleStore` this replaced did (`value.includes('blue')`), and it got
 * two of these four wrong: `ocean_blue` contains `indigo-950` and matched the `blue`
 * branch by accident, and `sunset_purple` is three hues and matched `purple`, silently
 * discarding the pink and the rose. A gradient has no single colour to read out of it,
 * so somebody has to say which one the theme follows.
 */
export interface WallpaperPreset {
  id: string;
  label: string;
  /** The class or CSS value applied to the screen. */
  value: string;
  /** The colour the M3 theme is generated from while this wallpaper is active. */
  seed: string;
}

export const PRESETS: readonly WallpaperPreset[] = [
  {
    id: 'dark_gradient',
    label: 'Dark Midnight',
    value: 'bg-gradient-to-br from-gray-800 to-gray-900',
    seed: '#155dfc'
  },
  {
    id: 'ocean_blue',
    label: 'Ocean Blue',
    value: 'bg-gradient-to-br from-blue-900 to-indigo-950',
    seed: '#1c398e'
  },
  {
    id: 'sunset_purple',
    label: 'Sunset Neon',
    value: 'bg-gradient-to-br from-purple-900 via-pink-900 to-rose-950',
    seed: '#8e0b52'
  },
  {
    id: 'emerald_forest',
    label: 'Emerald Dark',
    value: 'bg-gradient-to-br from-emerald-950 to-teal-900',
    seed: '#005f5a'
  },
  { id: 'solid_charcoal', label: 'Charcoal', value: 'rgb(24, 24, 27)', seed: '#52525b' },
  { id: 'solid_navy', label: 'Navy Blue', value: 'rgb(15, 23, 42)', seed: '#334155' }
];

export const DEFAULT_WALLPAPER: WallpaperState = {
  type: 'preset',
  value: PRESETS[0].value
};

/**
 * A stored preset value is applied to the screen as a **class name**, and Tailwind only
 * generates classes it saw in the source. So a value left over from an older `PRESETS`
 * list is one that was never compiled: no error, no background, an invisible wallpaper.
 * Checking it against the list is what keeps that from outliving a rename.
 */
const sanitizeWallpaper = (stored: unknown): WallpaperState => {
  if (!stored || typeof stored !== 'object') return DEFAULT_WALLPAPER;

  const { type, value } = stored as Record<string, unknown>;
  if (typeof value !== 'string' || value.length === 0) return DEFAULT_WALLPAPER;

  if (type === 'preset') {
    return PRESETS.some((p) => p.value === value) ? { type, value } : DEFAULT_WALLPAPER;
  }

  return type === 'color' || type === 'image' ? { type, value } : DEFAULT_WALLPAPER;
};

export const wallpaperStore = usePersisted<WallpaperState>(
  'settings',
  'wallpaper',
  DEFAULT_WALLPAPER,
  { sanitize: sanitizeWallpaper }
);

/**
 * Set the wallpaper, and move the theme with it when the caller knows a seed.
 *
 * The seed is a separate argument rather than something read back out of `wallpaper`,
 * so the two can also be set independently — a player may want a photo background and a
 * hand-picked accent, and nothing here forces them together.
 */
export const setWallpaper = (wallpaper: WallpaperState, seed?: string) => {
  wallpaperStore.set(wallpaper);
  if (seed) setThemeSeed(seed);
};

export const setPresetWallpaper = (preset: WallpaperPreset) =>
  setWallpaper({ type: 'preset', value: preset.value }, preset.seed);

export const resetWallpaper = () => setWallpaper(DEFAULT_WALLPAPER, PRESETS[0].seed);
