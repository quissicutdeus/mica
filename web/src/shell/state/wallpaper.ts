import { derived } from 'svelte/store';
import { usePersisted } from '../../sdk/hooks/usePersisted';
import { backgroundForScheme, buildSchemes, sanitizeSeed } from '../../lib/m3';
import { schemeStore, setThemeSeed, themeStore, type ThemeMode } from './theme';

/**
 * The home screen background.
 *
 * There are exactly two kinds, because there are exactly two things a background can be:
 * a color, or a picture.
 *
 * A color needs no `value` of its own — it *is* the theme seed, and the gradient is
 * generated from the scheme that seed produces. That is what makes a preset and a color
 * dragged off the wheel the same thing: a preset is a picked color with a name.
 *
 * This used to be three kinds — `preset` holding a Tailwind class string, `color` holding
 * a CSS color, `image` holding a `url(...)` shorthand — with the seed carried alongside
 * as a second, independent field. Three formats in one `value`, discriminated by `type`,
 * which forced `PhoneFrame` to decide between a `class` and a `style` for every render.
 * And because the picture and the seed were chosen separately, they could disagree: the
 * shipped "Dark Midnight" was a gray gradient with a blue seed.
 */
export type WallpaperState = { type: 'color' } | { type: 'image'; image: string };

export interface WallpaperPreset {
  id: string;
  label: string;
  /** The color the whole phone — wallpaper included — is generated from. */
  seed: string;
}

/**
 * The offered colors, chosen for **distinct hue**.
 *
 * M3 builds a scheme from a seed's hue, normalizing its chroma and discarding its
 * lightness, so two seeds of the same hue produce byte-identical themes however different
 * they look side by side. The previous list had four blues and near-neutral grays among
 * six entries, and clicking between them changed nothing at all. `wallpaper.test.ts`
 * asserts the generated schemes are visibly apart rather than merely unequal.
 *
 * A near-neutral gray cannot be one of these: it has no stable hue to generate from, so it
 * lands on whatever the maths rounds to — which is why "Charcoal" and "Navy Blue" came out
 * as the same blue as the default and had to go rather than be re-seeded.
 */
export const PRESETS: readonly WallpaperPreset[] = [
  { id: 'midnight', label: 'Midnight', seed: '#155dfc' },
  { id: 'ocean', label: 'Ocean', seed: '#0891b2' },
  { id: 'forest', label: 'Forest', seed: '#16a34a' },
  { id: 'sunset', label: 'Sunset', seed: '#db2777' },
  { id: 'ember', label: 'Ember', seed: '#ea580c' },
  { id: 'violet', label: 'Violet', seed: '#7c3aed' }
];

export const DEFAULT_WALLPAPER: WallpaperState = { type: 'color' };

/**
 * A stored wallpaper outlives the code that wrote it, and an image is a `url(...)` that
 * goes straight into a `background` property — so a stored value that is not one is
 * refused rather than rendered.
 */
const sanitizeWallpaper = (stored: unknown): WallpaperState => {
  if (!stored || typeof stored !== 'object') return DEFAULT_WALLPAPER;

  const { type, image } = stored as Record<string, unknown>;
  if (type === 'image' && typeof image === 'string' && image.startsWith('url(')) {
    return { type, image };
  }
  return DEFAULT_WALLPAPER;
};

/**
 * The one preference that stays on this PC.
 *
 * Every other setting follows the player's citizenid to any machine. This one cannot
 * affordably: a custom wallpaper is a base64 data URL of unbounded size, and syncing it
 * would push megabytes across the NUI bridge and into MySQL every time the color changed.
 *
 * The part players actually notice does still follow them — the seed and light/dark mode
 * live in `themeStore`, which syncs, and they are what generate the whole scheme. What
 * stays behind is a photo you set from this machine's own gallery.
 */
export const wallpaperStore = usePersisted<WallpaperState>(
  'settings',
  'wallpaper',
  DEFAULT_WALLPAPER,
  { sanitize: sanitizeWallpaper, sync: false }
);

/**
 * The CSS `background` for whatever is currently set.
 *
 * One value, one format, whichever kind of wallpaper it is — so `PhoneFrame` writes it to
 * one property and never chooses between a class and a style.
 */
export const wallpaperBackground = derived(
  [wallpaperStore, schemeStore],
  ([$wallpaper, $scheme]) =>
    $wallpaper.type === 'image'
      ? `${$wallpaper.image} center/cover no-repeat`
      : backgroundForScheme($scheme)
);

/** Pick a color: the wallpaper and every role in the phone follow it together. */
export const setWallpaperSeed = (seed: string) => {
  wallpaperStore.set({ type: 'color' });
  setThemeSeed(seed);
};

export const setPresetWallpaper = (preset: WallpaperPreset) => setWallpaperSeed(preset.seed);

/**
 * Use a photo, optionally re-seeding the theme from its dominant color.
 *
 * The seed is separate because a photo does not have to dictate the accent — and
 * `seedFromImage` returns `null` when it cannot read one, in which case the picture
 * changes and the colors stay put.
 */
export const setWallpaperImage = (image: string, seed?: string) => {
  wallpaperStore.set({ type: 'image', image });
  if (seed) setThemeSeed(sanitizeSeed(seed));
};

export const resetWallpaper = () => setWallpaperSeed(PRESETS[0].seed);

/**
 * What a given seed would look like, without applying it.
 *
 * The swatch a preset button renders is the wallpaper that preset produces, generated the
 * same way — so the button cannot advertise one thing and set another, which is exactly
 * what a hand-written gradient beside a hand-written seed allowed.
 */
export const backgroundForSeed = (seed: string, mode: ThemeMode): string =>
  backgroundForScheme(buildSchemes(sanitizeSeed(seed))[mode]);

/**
 * Whether anything drawn straight onto the wallpaper needs help being readable.
 *
 * True only for a photo. A generated gradient is built from the same scheme as the text
 * on top of it, so the contrast is already guaranteed; an arbitrary photograph guarantees
 * nothing.
 */
export const wallpaperNeedsContrast = derived(
  wallpaperStore,
  ($wallpaper) => $wallpaper.type === 'image'
);

/** The seed in use, for a picker that wants to open on the current color. */
export const activeSeed = derived(themeStore, ($theme) => $theme.seed);
