import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROLE_NAMES, TOKEN_NAMES } from './lib/m3';

/**
 * The CEF capability baseline, enforced.
 *
 * FiveM's release CEF is Chromium 103. This scans markup for the Tailwind-shaped class
 * *syntax* the app still uses in `class=` attributes (`bg-black/40`, `hover:bg-x`, …) —
 * `app-utilities.css` implements each one as a hand-written literal `rgba()` rule, never
 * `color-mix()`, so an opacity modifier on a *palette* color is CEF 103-safe outright.
 * AGENTS.md §6 has said so in prose the whole time, and the prose did not stop 146
 * opacity modifiers landing before the token migration; the budget below is what keeps
 * that count from creeping back up.
 *
 * The `:has()` and container-query rules have no such fallback and are absolute.
 *
 * Note what none of this can do: a green run here is not evidence that anything renders
 * in game. Real verification is `nui_devTools`, checking the *computed* value.
 */

const ROOT = join(__dirname, '..', '..');
const SCAN = ['src/apps', 'src/sdk', 'src/shell'];

/**
 * Utilities that take a color. The prefix list is what separates an opacity modifier
 * from a fraction: `bg-gray-800/50` is `color-mix()`, `h-2/3` is a height, and a regex
 * that only looked for `<something>/<number>` would condemn `Avatar.svelte` for a
 * perfectly ordinary two-thirds.
 */
const COLOR_PROPS =
  'bg|text|border|ring|shadow|from|via|to|divide|outline|decoration|placeholder|accent|fill|stroke|caret';

/** `bg-gray-800/50`, `hover:bg-white/10`, `shadow-blue-600/30`. */
const OPACITY_MODIFIER = new RegExp(
  String.raw`\b(?:[a-z-]+:)*(?:${COLOR_PROPS})-[a-zA-Z0-9\[\]#().,%_-]+\/\d{1,3}\b`,
  'g'
);

/**
 * `has-[...]:`, `group-has-checked:`. The trailing colon is required so the pattern
 * cannot fire on ordinary prose in a comment — which is exactly how a structural test
 * in this repo has drawn a false positive before.
 */
const HAS_VARIANT = /\b(?:group-|peer-)?has-(?:\[[^\]]*\]|[a-z-]+):/g;

/** `@container`, `@min-[400px]:`, `@max-[400px]:`. */
const CONTAINER_QUERY = /@container\b|@(?:min|max)-\[/g;

/**
 * How many opacity modifiers each file is still allowed.
 *
 * A ratchet, not an exemption list. It started at 146 across 23 files, predating the
 * token set; the numbers may only go down, and the M3 migration took it to 30 across 9.
 * Migrating a file means lowering its number, and emptying it means deleting the line.
 *
 * What is left is deliberate rather than unfinished. Every survivor is translucency over
 * something the theme does not own — the camera viewfinder and the phone's own bezel show
 * the game world through them, the volume HUD floats on its own slab, and the browser-only
 * launch button in `Shell` lives outside the phone entirely. A role token would be the
 * wrong answer for all of those, not merely an unmade change.
 *
 * `src/sdk` is deliberately absent: the primitives were migrated first, so a scaffolded
 * app inherits a CEF-safe palette without knowing this rule exists.
 */
const GRANDFATHERED: Record<string, number> = {
  'src/apps/camera/index.svelte': 13,
  'src/apps/contacts/components/ContactDetails.svelte': 2,
  'src/apps/messages/components/MessageComposer.svelte': 2,
  'src/apps/messages/components/MessageThread.svelte': 1,
  // Both inherited from `media/index.svelte`, which MICA-110 split into these two —
  // `bg-black/80` on the full view's action bar and `bg-black/20` on the grid's
  // unselected checkbox. Two before the split, two after.
  'src/apps/media/components/PhotoDetail.svelte': 1,
  'src/apps/media/components/PhotoGrid.svelte': 1,
  'src/apps/store/components/AppDetails.svelte': 1,
  'src/shell/PhoneFrame.svelte': 3,
  'src/shell/Shell.svelte': 1,
  'src/shell/ToastHost.svelte': 6,
  'src/shell/VolumeHud.svelte': 5
};

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(svelte|ts)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

const FILES = SCAN.flatMap((dir) => walk(join(ROOT, dir))).map((f) => ({
  path: relative(ROOT, f).replace(/\\/g, '/'),
  text: readFileSync(f, 'utf8')
}));

const countOf = (text: string, rx: RegExp) => (text.match(rx) ?? []).length;

/** Every `--name` declared across the hand-written CSS layer. */
const declaredProperties = (): Set<string> => {
  const names = new Set<string>();
  for (const file of ['app.css', 'app-utilities.css', 'app-reset.css']) {
    const full = join(ROOT, 'src', 'sdk', file);
    if (!existsSync(full)) continue;
    for (const m of readFileSync(full, 'utf8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) names.add(m[1]);
  }
  return names;
};

/**
 * What a `var()` in markup may resolve to: the declared layer above, plus every
 * `--color-*` role `PhoneFrame` writes onto the screen element at runtime.
 */
const RESOLVABLE_PROPERTIES = new Set([
  ...declaredProperties(),
  ...TOKEN_NAMES.map((name) => `--color-${name}`)
]);

/** Colour syntax newer than Chromium 103, with no fallback once it is past PostCSS. */
const POST_103_COLOR = /\b(?:color-mix|oklab|oklch)\(|\b(?:rgba?|hsla?|hwb|lab|lch)\(\s*from\b/g;

/** Drops any `{...}` span, leaving only the statically-known text around it. */
const stripInterpolations = (text: string): string => {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
};

/** The statically-known text of every `style="..."` attribute in a component. */
const inlineStyles = (text: string): string[] =>
  [...text.matchAll(/\bstyle="([^"]*)"/g)].map((m) => stripInterpolations(m[1]));

describe('CEF capability baseline (AGENTS.md §6)', () => {
  it('finds files to check', () => {
    // A walk that silently matched nothing would make every rule below vacuous.
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('adds no new opacity modifier', () => {
    // Palette-color opacity modifiers are fine now (see the file header) — this ratchet
    // is about keeping the class surface consistent, not a CEF-safety requirement. On a
    // themed role, though, prefer a pre-resolved `rgb(... / ...)` token in `app.css`.
    const added = FILES.map(({ path, text }) => ({
      path,
      found: countOf(text, OPACITY_MODIFIER),
      allowed: GRANDFATHERED[path] ?? 0
    }))
      .filter(({ found, allowed }) => found > allowed)
      .map(({ path, found, allowed }) => `${path}: ${found} (allowed ${allowed})`);

    expect(added, 'use an @theme token with a pre-resolved rgb(... / ...) value').toEqual([]);
  });

  it('has a grandfather list that only goes down', () => {
    // Without this the list rots: a file migrated to tokens keeps its old budget, and
    // that budget silently becomes room for a new violation later.
    const stale = Object.entries(GRANDFATHERED)
      .map(([path, allowed]) => {
        const file = FILES.find((f) => f.path === path);
        return { path, allowed, found: file ? countOf(file.text, OPACITY_MODIFIER) : 0 };
      })
      .filter(({ found, allowed }) => found < allowed)
      .map(({ path, found, allowed }) =>
        found === 0
          ? `${path}: now clean — delete the line`
          : `${path}: down to ${found} — lower the number from ${allowed}`
      );

    expect(stale, 'the ratchet tightened; update GRANDFATHERED to match').toEqual([]);
  });

  it('puts no opacity modifier on a themed role token', () => {
    // A hard zero, not a budget, and the reasoning is different from the rule above.
    //
    // A *palette* color like `bg-gray-800/50` is a literal `rgba()` in `app-utilities.css`
    // — that is why the rule above is a consistency ratchet rather than a CEF-safety one.
    //
    // A role token is themed at runtime: `PhoneFrame` writes all 47 as inline custom
    // properties from the player's seed. `app-utilities.css` does not even generate a
    // class for a role name with an opacity modifier (`bg-surface/50` matches no rule),
    // so the safe failure mode is "renders with no background" — still worth catching
    // here before it ships, rather than debugging a class with nothing behind it.
    //
    // State layers are the sanctioned alternative and are already flattened to opaque
    // values by `lib/m3.ts`: write `hover:bg-surface-container-hover`, not
    // `hover:bg-surface-container/8`.
    const roles = [...ROLE_NAMES].sort((a, b) => b.length - a.length).join('|');
    const themedOpacity = new RegExp(
      String.raw`\b(?:[a-z-]+:)*(?:${COLOR_PROPS})-(?:${roles})\/\d{1,3}\b`,
      'g'
    );

    const offenders = FILES.flatMap(({ path, text }) =>
      (text.match(themedOpacity) ?? []).map((hit) => `${path}: ${hit}`)
    );

    expect(offenders, 'use a pre-composited state-layer token, not an opacity modifier').toEqual(
      []
    );
  });

  it('resolves every custom property an inline style= reaches for', () => {
    // MICA-85, twice over. The Bank card's gradient lived in a `style=` attribute
    // reaching for `--color-purple-600` / `--color-blue-600`. Those were Tailwind v4
    // *theme* variables holding `oklch()` (Chromium 111), so the card painted in a dev
    // browser and was blank in game; then Tailwind was removed and the class-scan that
    // replaced it only ever looked at `class=`, so the two names have resolved to
    // nothing since. An unresolvable `var()` makes the whole declaration invalid at
    // computed-value time — `background-image` falls back to `none`, silently.
    //
    // The set below is everything a markup attribute may reach for: the properties
    // declared in the hand-written CSS layer, plus the roles `PhoneFrame` writes onto
    // the screen element at runtime from the player's seed.
    const offenders = FILES.flatMap(({ path, text }) =>
      inlineStyles(text)
        .flatMap((style) => [...style.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]))
        .filter((name) => !RESOLVABLE_PROPERTIES.has(name))
        .map((name) => `${path}: var(${name})`)
    );

    expect(offenders, 'declare the property in app.css, or use a utility class').toEqual([]);
  });

  it('keeps an inline style= inside the CEF 103 floor', () => {
    // `postcss.config.js` transpiles `oklab()`/`oklch()` and nesting — but PostCSS only
    // ever sees `.css` files and `<style>` blocks. A markup attribute is not part of the
    // pipeline, so a colour function newer than Chromium 103 written there reaches CEF
    // untouched and drops the declaration. `lib/m3.ts` emits the wallpaper as plain
    // `rgb()` for exactly this reason; a static attribute must do the same.
    const offenders = FILES.flatMap(({ path, text }) =>
      inlineStyles(text)
        .flatMap((style) => [...style.matchAll(POST_103_COLOR)].map((m) => m[0]))
        .map((hit) => `${path}: ${hit}`)
    );

    expect(offenders, 'an inline style bypasses PostCSS — write rgb()/rgba()').toEqual([]);
  });

  it('uses no :has() variant', () => {
    // Chromium 105. Nothing in the tree uses one today; use Svelte state instead.
    const offenders = FILES.filter(({ text }) => HAS_VARIANT.test(text)).map((f) => f.path);
    expect(offenders, 'use Svelte state rather than :has()').toEqual([]);
  });

  it('uses no container query', () => {
    // Chromium 105. Also clean today.
    const offenders = FILES.filter(({ text }) => CONTAINER_QUERY.test(text)).map((f) => f.path);
    expect(offenders, 'use Svelte state rather than a container query').toEqual([]);
  });
});
