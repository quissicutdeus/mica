import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROLE_NAMES } from '../lib/m3';

/**
 * The CEF capability baseline, enforced.
 *
 * FiveM's release CEF is Chromium 103. Tailwind 4's baseline is Chromium 111. Anything
 * in that gap renders correctly in `pnpm dev`, passes Playwright — which drives a modern
 * Chromium — and is broken in game. AGENTS.md §6 has said so in prose the whole time,
 * and the prose did not stop 146 opacity modifiers landing.
 *
 * One correction to §6, from reading the built CSS rather than the docs: Tailwind emits
 * an unguarded hex fallback alongside the `@supports`-guarded `color-mix()`, so an
 * opacity modifier on a *palette* color does survive CEF 103. It is only where Tailwind
 * cannot resolve the color at build time — an arbitrary `var()`-based color — that the
 * fallback is absent and the utility breaks outright. The budget below is therefore a
 * consistency ratchet with a real but narrow correctness edge, not a bug count.
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
  'src/apps/phone/index.svelte': 3,
  'src/apps/media/index.svelte': 2,
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

describe('CEF capability baseline (AGENTS.md §6)', () => {
  it('finds files to check', () => {
    // A walk that silently matched nothing would make every rule below vacuous.
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('adds no new opacity modifier', () => {
    // They compile to `color-mix()`, which needs Chromium 111. Define a token with a
    // pre-resolved `rgb(... / ...)` value in `app.css` instead.
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
    // For a *palette* color Tailwind emits an unguarded hex fallback beside the
    // `@supports`-guarded `color-mix()`, so `bg-gray-800/50` does render in CEF 103 —
    // that is why the rule above is a consistency ratchet rather than a bug count.
    //
    // A role token is themed at runtime: `PhoneFrame` writes all 47 as inline custom
    // properties from the player's seed. Tailwind still computes its fallback from the
    // literal in `app.css`, which is the *default* seed — so `bg-surface/50` renders the
    // shipped theme's color for anybody who changed theirs. It fails silently, only for
    // some players, and only for the color they explicitly picked.
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
