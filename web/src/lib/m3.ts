import {
  argbFromHex,
  blueFromArgb,
  greenFromArgb,
  Hct,
  redFromArgb,
  SchemeTonalSpot
} from '@material/material-color-utilities';

/**
 * The phone's colour system: Material 3 roles, generated from one seed colour.
 *
 * This replaces sixteen hand-picked tokens that had no `on-` roles at all — nothing
 * stated what text goes *on* a surface, so 1190 raw palette utilities across the tree
 * each answered that question independently. Once the surface can follow the wallpaper,
 * every one of those is a guess.
 *
 * ## Why the maths happens here and not in CSS
 *
 * M3 is normally expressed with `color-mix()` — state layers are an overlay of `on-X`
 * at 8%, disabled content is `on-surface` at 38%. `color-mix()` is Chromium 111 and
 * FiveM's release CEF is 103 (AGENTS.md §6), so none of that survives in game.
 *
 * So every value this module emits is a fully resolved `rgb()` / `rgba()` string, and
 * the state layers are composited numerically in {@link composite} rather than deferred
 * to the browser. Nothing downstream needs a colour function newer than CSS 2. That is
 * also what lets `sdk/` stay at zero opacity modifiers under `cef.test.ts`: a state
 * layer is a flat opaque colour here, not `bg-surface/8`.
 *
 * ## Why not MCU's own helpers
 *
 * `themeFromSourceColor()` and `applyTheme()` look like exactly this function and are
 * not. Both emit the legacy 2021 `Scheme` class, which has no `surface-container-*`
 * tiers and no `surface-dim`/`surface-bright` — so the standard role set is not
 * expressible through them. Every `MaterialDynamicColors.*` static is `@deprecated` in
 * 0.4.0 as well. `DynamicScheme`'s role getters are the current path.
 *
 * The dependency is pinned exactly, no caret. The role set changed between 0.2.x and
 * 0.4 and deprecated the statics on the way; a caret range means every colour in the
 * phone can move on an unrelated `pnpm install`.
 */

/**
 * The seed the shipped theme is built from — today's `--color-accent`, blue-600, so a
 * fresh install looks like the phone always has.
 */
export const DEFAULT_SEED = '#155dfc';

/**
 * The 34 M3 colour roles, kebab-case, in declaration order.
 *
 * Three groups are deliberately absent, each on M3's own authority rather than ours:
 *
 * - `background` / `on-background` — deprecated in favour of `surface` / `on-surface`,
 *   which they duplicate exactly. Two names for one value is the forking problem this
 *   file exists to end.
 * - `surface-variant` — deprecated as a container role, superseded by
 *   `surface-container-highest`. `on-surface-variant` survives without it, and that is
 *   what keeps the text roles at two.
 * - The twelve `*-fixed` / `*-fixed-dim` / `on-*-fixed` / `on-*-fixed-variant` roles.
 *   They exist so an Android home-screen widget can hold one colour across the host
 *   app's light/dark switch. The phone has no such surface.
 *
 * Two on-surface text roles, `on-surface` and `on-surface-variant`, and no third. The
 * temptation is real — the tree currently uses four grey tiers (200/300/400/500) and
 * collapsing them makes some screens read flatter. M3's answer to that is type scale
 * and spacing, not another colour, and inventing a third tier here would mean every
 * component picking between three greys again with nothing to say which is right.
 */
export const ROLE_NAMES = [
  'primary',
  'on-primary',
  'primary-container',
  'on-primary-container',
  'inverse-primary',

  'secondary',
  'on-secondary',
  'secondary-container',
  'on-secondary-container',

  'tertiary',
  'on-tertiary',
  'tertiary-container',
  'on-tertiary-container',

  'error',
  'on-error',
  'error-container',
  'on-error-container',

  'surface',
  'surface-dim',
  'surface-bright',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
  'on-surface',
  'on-surface-variant',
  'inverse-surface',
  'inverse-on-surface',

  'outline',
  'outline-variant',

  'shadow',
  'scrim',
  'surface-tint'
] as const;

/** `surface-container-high` -> `surfaceContainerHigh`, the getter on `DynamicScheme`. */
const camel = (kebab: string): string =>
  kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * M3 state layer opacities. Hover is 8%, pressed 10%.
 *
 * Focus is also 10% and is deliberately not emitted: nothing in the phone renders a
 * distinct focus fill today, and a token no component consumes is one more value to
 * keep honest for nothing.
 */
const HOVER_ALPHA = 0.08;
const PRESSED_ALPHA = 0.1;

/**
 * Which roles get a state layer, and what is layered over them.
 *
 * Not every role needs one — only those something is actually pressed on. The set is
 * driven by what the components do: list rows and the header sit on surface and
 * surface-container, `Button` has a filled primary and a secondary on container-high,
 * chips sit on secondary-container, and destructive buttons on error.
 */
const STATE_LAYER_BASES = [
  ['surface', 'on-surface'],
  ['surface-container', 'on-surface'],
  ['surface-container-high', 'on-surface'],
  ['primary', 'on-primary'],
  ['secondary-container', 'on-secondary-container'],
  ['error', 'on-error']
] as const;

/**
 * The one token here with no M3 role behind it: the FAB's coloured bloom, primary at
 * 30% for a `box-shadow`. It is an elevation effect rather than a semantic role, and it
 * is named so that stays obvious. The purist alternative is M3's `shadow` role, which
 * is pure black and loses the glow entirely.
 */
const GLOW_ALPHA = 0.3;

/**
 * M3 specifies `scrim` as a *role* of tone 0 — opaque black — and applies it at 32%
 * where it is used. That split cannot survive here: an opacity modifier on a themed
 * token is the one thing `cef.test.ts` now forbids outright, because Tailwind computes
 * its unguarded fallback from the build-time literal and would render the default
 * seed's colour under any other seed.
 *
 * A scrim is also the one role that genuinely cannot be composited in advance, since it
 * lies over whatever screen happens to be behind the dialog. So the usage alpha is
 * baked into the token instead. 0.32 is M3's number and is a visible lightening of the
 * 0.8 this codebase used before.
 */
const SCRIM_ALPHA = 0.32;

export const STATE_TOKEN_NAMES: readonly string[] = [
  ...STATE_LAYER_BASES.flatMap(([base]) => [`${base}-hover`, `${base}-pressed`]),
  'primary-glow'
];

/** Every `--color-*` this module emits: the 34 roles plus the 13 derived values. */
export const TOKEN_NAMES: readonly string[] = [...ROLE_NAMES, ...STATE_TOKEN_NAMES];

export type M3Tokens = Record<string, string>;

/**
 * Source-over compositing in sRGB: `on` at `alpha` laid over `base`, flattened.
 *
 * The whole point is that the result is opaque, so a state layer costs no opacity
 * modifier and no `color-mix()`. Compositing in plain sRGB rather than a perceptual
 * space is what a browser would have done for a translucent overlay anyway, so this
 * matches what the `color-mix()` version would have rendered on a modern engine.
 */
export function composite(baseArgb: number, onArgb: number, alpha: number): string {
  const mix = (channel: (argb: number) => number) =>
    Math.round(channel(onArgb) * alpha + channel(baseArgb) * (1 - alpha));

  return `rgb(${mix(redFromArgb)}, ${mix(greenFromArgb)}, ${mix(blueFromArgb)})`;
}

/**
 * Legacy comma syntax, not `rgb(r g b / a)`.
 *
 * The modern space-separated form is Chromium 65 and would be safe on its own. But
 * values written from here reach the DOM through an inline `style` attribute and never
 * pass through `web/postcss.config.js`, so there is no lowering step behind them.
 * Legacy syntax removes the question rather than answering it.
 */
const rgb = (argb: number): string =>
  `rgb(${redFromArgb(argb)}, ${greenFromArgb(argb)}, ${blueFromArgb(argb)})`;

const rgba = (argb: number, alpha: number): string =>
  `rgba(${redFromArgb(argb)}, ${greenFromArgb(argb)}, ${blueFromArgb(argb)}, ${alpha})`;

const schemeFor = (seedHex: string, isDark: boolean) =>
  new SchemeTonalSpot(Hct.fromInt(argbFromHex(seedHex)), isDark, 0);

/**
 * Both schemes for one seed.
 *
 * Light is generated even though only dark is wired up, because the assignment tables
 * are MCU's rather than ours — building one and not the other would save nothing and
 * would leave the shape of the module implying a choice that has not been made. Turning
 * light on later is a change to which record `shell/state/theme.ts` reads.
 *
 * `SchemeTonalSpot` is the Material You default from Android 12/13 and is documented as
 * "low to medium colorfulness": a seed is interpreted rather than reproduced, so a very
 * saturated pick comes back muted. That restraint is the point at phone scale, but it
 * is the one thing here a player might read as a bug — `Variant.VIBRANT` is the knob if
 * that judgement changes.
 */
export function buildSchemes(seedHex: string): { light: M3Tokens; dark: M3Tokens } {
  const build = (isDark: boolean): M3Tokens => {
    const scheme = schemeFor(seedHex, isDark);
    const argbOf = (role: string): number =>
      (scheme as unknown as Record<string, number>)[camel(role)];

    const tokens: M3Tokens = {};
    for (const role of ROLE_NAMES) tokens[role] = rgb(argbOf(role));
    tokens['scrim'] = rgba(argbOf('scrim'), SCRIM_ALPHA);

    for (const [base, on] of STATE_LAYER_BASES) {
      tokens[`${base}-hover`] = composite(argbOf(base), argbOf(on), HOVER_ALPHA);
      tokens[`${base}-pressed`] = composite(argbOf(base), argbOf(on), PRESSED_ALPHA);
    }
    tokens['primary-glow'] = rgba(argbOf('primary'), GLOW_ALPHA);

    return tokens;
  };

  return { light: build(false), dark: build(true) };
}

/**
 * The tokens as a `style` attribute value, for the phone screen element.
 *
 * A string rather than a series of `setProperty` calls because Svelte's `style={...}`
 * takes one, and because it is trivially assertable in a test.
 */
export function cssVarBlock(tokens: M3Tokens): string {
  return TOKEN_NAMES.map((name) => `--color-${name}: ${tokens[name]};`).join(' ');
}

/**
 * A seed is a six-digit hex colour and nothing else.
 *
 * Narrow on purpose: this runs on a value read back from storage, which a player can
 * edit, and it is the only thing standing between that and `argbFromHex`. Three-digit
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
 * The alpha is dropped rather than honoured: a seed names a hue for the generator to
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
