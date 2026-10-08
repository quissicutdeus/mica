// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROLE_NAMES, TOKEN_NAMES } from './lib/m3';
import {
  colorTokensDeclared,
  cssColorHits,
  declaredProperties as declaredIn,
  inlineStyles as inlineStylesOf,
  opacityModifierPattern,
  POST_103_COLOR,
  roleOpacityPattern
} from './checks/cef.js';
import { listFiles, styleBlocks } from './checks/source.js';

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
 * The `:has()` and container-query rules are now caught by stylelint
 * (plugin/no-unsupported-browser-features) and are no longer tested here.
 *
 * Note what none of this can do: a green run here is not evidence that anything renders
 * in game. Real verification is `nui_devTools`, checking the *computed* value.
 */

// MICA-172: `__dirname` is `sdk/` at the repo root now, so one hop up is the repo root
// and the scanned trees are named from there — the SDK as a sibling of `web/`, not inside it.
const ROOT = join(__dirname, '..');
const SCAN = ['web/src/apps', 'sdk', 'web/src/shell'];

/**
 * `bg-gray-800/50`, `hover:bg-white/10`, `shadow-blue-600/30`. MICA-312: the pattern, and the
 * prefix list that tells an opacity modifier from a fraction (`h-2/3`), live in
 * `checks/cef.js`, where an add-on's `pnpm check` reads them too.
 */
const OPACITY_MODIFIER = opacityModifierPattern();

/**
 * Pattern `has-[...]:`, `group-has-checked:` is now caught by stylelint.
 * Pattern `@container`, `@min-[400px]:`, `@max-[400px]:` is now caught by stylelint.
 * The regexes are retired with the tests.
 */

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
 * `sdk` is deliberately absent: the primitives were migrated first, so a scaffolded
 * app inherits a CEF-safe palette without knowing this rule exists.
 */
const GRANDFATHERED: Record<string, number> = {
  'web/src/apps/camera/index.svelte': 13,
  'web/src/apps/contacts/components/ContactDetails.svelte': 2,
  'web/src/apps/messages/components/MessageComposer.svelte': 2,
  'web/src/apps/messages/components/MessageThread.svelte': 1,
  // Both inherited from `media/index.svelte`, which MICA-110 split into these two —
  // `bg-black/80` on the full view's action bar and `bg-black/20` on the grid's
  // unselected checkbox. Two before the split, two after.
  'web/src/apps/media/components/PhotoDetail.svelte': 1,
  'web/src/apps/media/components/PhotoGrid.svelte': 1,
  'web/src/apps/store/components/AppDetailsBody.svelte': 1,
  // MICA-259 moved `PhoneFrame`'s three into the pieces the tablet frame shares.
  'web/src/shell/frame/DeadBatteryScreen.svelte': 2,
  'web/src/shell/frame/HomeIndicator.svelte': 1,
  'web/src/shell/Shell.svelte': 1,
  'web/src/shell/ToastHost.svelte': 6,
  'web/src/shell/VolumeHud.svelte': 5
};

// MICA-172: `sdk/` is a workspace package now and has its own `node_modules`, which
// `listFiles` never descends into — without that the walk reads TypeScript's own
// `lib.dom.d.ts` and reports it.
const walk = (dir: string): string[] =>
  listFiles(dir, ['.svelte', '.ts']).filter((file) => !file.endsWith('.test.ts'));

const FILES = SCAN.flatMap((dir) => walk(join(ROOT, dir))).map((f) => ({
  path: relative(ROOT, f).replace(/\\/g, '/'),
  text: readFileSync(f, 'utf8')
}));

const countOf = (text: string, rx: RegExp) => (text.match(rx) ?? []).length;

/** The hand-written CSS layer, as text. */
const SDK_CSS = ['app.css', 'app-utilities.css', 'app-reset.css']
  .map((file) => join(ROOT, 'sdk', file))
  .filter((full) => existsSync(full))
  .map((full) => readFileSync(full, 'utf8'));

/** Every `--name` declared across the hand-written CSS layer. */
const declaredProperties = (): Set<string> => declaredIn(SDK_CSS);

/**
 * What a `var()` in markup may resolve to: the declared layer above, plus every
 * `--color-*` role `PhoneFrame` writes onto the screen element at runtime.
 */
const RESOLVABLE_PROPERTIES = new Set([
  ...declaredProperties(),
  ...TOKEN_NAMES.map((name) => `--color-${name}`)
]);

/** The statically-known text of every `style="..."` attribute in a component. */
const inlineStyles = (text: string): string[] => inlineStylesOf(text).map(({ style }) => style);

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
    const themedOpacity = roleOpacityPattern(ROLE_NAMES);

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

  it('derives every themed role from app.css, for a checker that has no ROLE_NAMES', () => {
    // MICA-312. An add-on's `pnpm check` runs the role-token opacity ban from
    // `node_modules/@mica/sdk/`, in plain Node, where `lib/m3.ts` is TypeScript it cannot
    // load. It reads the roles off the shipped `app.css` instead, and this is what keeps
    // that answer from falling behind the canonical list.
    const derived = new Set(
      colorTokensDeclared(readFileSync(join(ROOT, 'sdk', 'app.css'), 'utf8'))
    );
    expect(ROLE_NAMES.filter((role) => !derived.has(role))).toEqual([]);
  });

  it('keeps every stylesheet and <style> block clear of color-mix() and relative colour', () => {
    // MICA-312. stylelint's browser-support plugin has no entry for `color-mix()` (8.1.1
    // flags `rgb(from …)` and not this), and PostCSS does not lower either, so `pnpm
    // lint:css` passes both. The same check an add-on's `pnpm check` runs, over this tree.
    const sheets = [
      ...listFiles(join(ROOT, 'sdk'), ['.css']),
      ...listFiles(join(ROOT, 'web/src'), ['.css'])
    ].map((full) => ({ path: relative(ROOT, full), css: readFileSync(full, 'utf8'), line: 1 }));
    const blocks = FILES.flatMap(({ path, text }) =>
      styleBlocks(text).map(({ css, line }) => ({ path, css, line }))
    );
    expect(sheets.length, 'found no stylesheet to check').toBeGreaterThanOrEqual(3);
    // Few on purpose — a utility class is the first answer here (AGENTS.md §5) — but not none.
    expect(blocks.length, 'found no <style> block to check').toBeGreaterThan(0);

    const offenders = [...sheets, ...blocks].flatMap(({ path, css, line }) =>
      cssColorHits(css).map((hit) => `${path}:${line + hit.line - 1}: ${hit.hit}`)
    );
    expect(offenders, 'past Chromium 103 with no fallback — write a literal rgba()').toEqual([]);
  });
});
