// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This repo has no Tailwind build (AGENTS.md §5): `app-utilities.css` is a flat,
 * hand-written utility layer, and a `class="..."` token with no matching rule there
 * simply renders as nothing — no build error, no lint warning, just a silently
 * no-op class. That happened three times in one PR (`pt-8`, `pt-12`,
 * `text-title-large`/`text-title-medium`) before anyone noticed the spacing was off by
 * eye. This test is the guard: every *statically discoverable* class token in `src/`
 * must resolve to a real selector in `app.css` / `app-utilities.css` / `app-reset.css`.
 *
 * "Statically discoverable" is a real limitation, not a formality — this is a regex
 * scan, not a JS/Svelte parser:
 * - Text inside a Svelte inline expression (`class="foo {bar}"`) or a template-literal
 *   `${...}` interpolation is skipped entirely, including string literals inside it
 *   (`{cond ? 'a-class' : ''}`). Distinguishing a class-producing branch from an
 *   unrelated comparison value (`x === 'settling'`) needs real parsing to do safely.
 * - A fully dynamic `class={someVar}` binding (an icon's `class` prop) isn't checked —
 *   there's no literal text to check statically, by construction.
 * - `.svelte` markup is scanned in full. `.ts` files are scanned only for the one
 *   concrete, already-known pattern that hands a class *string* straight to a
 *   component: an app manifest's `color` field (`AppIcon` interpolates it directly into
 *   a `class`, per `sdk/manifest.ts`). Arbitrary string-tracking across `.ts` is not the
 *   goal — that would mean a real parser to avoid flagging every unrelated string
 *   literal that happens to look class-shaped — so this stays narrow and deliberate
 *   rather than growing into a second, noisier scanner.
 *
 * Static tokens are exactly what bit us, so this still catches the real bug class
 * without needing a real parser.
 */

const WEB_SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Removes any `{...}`/`${...}` span, leaving only the statically-known text around it. */
function stripInterpolations(text: string): string {
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** Every class-selector name defined across the hand-written CSS layer, unescaped. */
function loadDefinedClasses(): Set<string> {
  const cssFiles = ['app.css', 'app-utilities.css', 'app-reset.css'];
  const defined = new Set<string>();
  // A leading `.` followed by a run of either an escaped pair (`\X`) or any char that
  // isn't a selector delimiter — stops at the first unescaped `.`, `:`, `,`, whitespace,
  // combinator, or `{`, which is exactly where a Tailwind-style hand-written class
  // selector (`.hover\:opacity-100:hover`, `.text-\[11px\]`) ends.
  const classSelectorRe = /\.((?:\\.|[^\s.{:,>+~[])+)/g;
  for (const name of cssFiles) {
    const filePath = path.join(WEB_SRC, '..', '..', 'sdk', name);
    if (!fs.existsSync(filePath)) continue;
    const css = fs.readFileSync(filePath, 'utf8');
    for (const match of css.matchAll(classSelectorRe)) {
      defined.add(match[1].replace(/\\(.)/g, '$1'));
    }
  }
  return defined;
}

interface ClassUsage {
  file: string;
  line: number;
  token: string;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Every statically-known class token referenced from `.svelte` markup. */
function findClassUsages(files: string[]): ClassUsage[] {
  const usages: ClassUsage[] = [];

  // `class="..."` (may embed `{expr}`) and `class={\`...\`}` (may embed `${expr}`).
  const classAttrRe = /\bclass="((?:[^"\\]|\\.)*)"/g;
  const classTemplateRe = /\bclass=\{`((?:[^`\\]|\\.)*)`\}/g;
  // `class:token` / `class:token={cond}` — Svelte's boolean class directive.
  const classDirectiveRe = /\bclass:([a-zA-Z][\w-]*)/g;

  for (const file of files) {
    // Strip HTML/Svelte template comments and JS/TS block comments before scanning —
    // otherwise a doc comment that *mentions* `class="..."` (this file has one) reads
    // as a real usage. Replaced with a matching run of newlines, not deleted outright,
    // so every later line number is still accurate against the original file.
    const blankComment = (match: string) => '\n'.repeat((match.match(/\n/g) ?? []).length);
    const source = fs
      .readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, blankComment)
      .replace(/\/\*[\s\S]*?\*\//g, blankComment);
    const rel = path.relative(WEB_SRC, file);

    for (const re of [classAttrRe, classTemplateRe]) {
      re.lastIndex = 0;
      for (const match of source.matchAll(re)) {
        // Template literals use `${expr}`; dropping the `$` before stripping lets the
        // same brace-depth walk handle both that and Svelte's plain `{expr}`.
        const staticText = stripInterpolations(match[1].replace(/\$\{/g, '{'));
        const line = lineOf(source, match.index ?? 0);
        for (const token of staticText.split(/\s+/).filter(Boolean)) {
          usages.push({ file: rel, line, token });
        }
      }
    }

    classDirectiveRe.lastIndex = 0;
    for (const match of source.matchAll(classDirectiveRe)) {
      usages.push({ file: rel, line: lineOf(source, match.index ?? 0), token: match[1] });
    }
  }

  return usages;
}

/** `tile: { bg: 'bg-x', fg: 'text-y' }` in a manifest, as the two classes it names. */
function readTile(source: string): { bg?: string; fg?: string; index: number } | null {
  const match = /\btile:\s*\{([^}]*)\}/.exec(source);
  if (!match) return null;
  return {
    bg: /\bbg:\s*'([^']*)'/.exec(match[1])?.[1],
    fg: /\bfg:\s*'([^']*)'/.exec(match[1])?.[1],
    index: match.index
  };
}

/**
 * Every statically-known class token from an app manifest's `tile`.
 *
 * `AppIcon` interpolates the tile straight into a `class` (see `sdk/manifest.ts`), so a
 * stale or typo'd token there is exactly the same silent-no-op failure a `.svelte`
 * `class="..."` typo is — it just lives one file away from where it renders. Narrow and
 * literal on purpose: only plain single-quoted string literals inside a `tile: { … }`
 * object are read. Anything computed is skipped rather than guessed at, the same reasoning
 * `stripInterpolations` applies to a Svelte `{expr}`.
 */
function findManifestTileUsages(files: string[]): ClassUsage[] {
  const usages: ClassUsage[] = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const tile = readTile(source);
    if (!tile) continue;
    const line = lineOf(source, tile.index);
    for (const token of [tile.bg, tile.fg].filter((t): t is string => !!t)) {
      usages.push({ file: path.relative(WEB_SRC, file), line, token });
    }
  }

  return usages;
}

describe('app-utilities.css coverage', () => {
  it('has a rule for every statically-known class token used in .svelte markup and app manifest tiles', () => {
    const defined = loadDefinedClasses();
    const svelteFiles = walk(WEB_SRC, ['.svelte']);
    const manifestFiles = walk(path.join(WEB_SRC, 'apps'), ['.ts']).filter((f) =>
      f.endsWith('manifest.ts')
    );
    const usages = [...findClassUsages(svelteFiles), ...findManifestTileUsages(manifestFiles)];

    const missing = usages.filter((u) => !defined.has(u.token));

    if (missing.length > 0) {
      const report = missing.map((u) => `  ${u.file}:${u.line} — "${u.token}"`).join('\n');
      expect.fail(
        `${missing.length} class token(s) with no matching rule in app.css / ` +
          `app-utilities.css / app-reset.css — this repo has no Tailwind build, so an ` +
          `unmatched class silently renders as nothing:\n${report}`
      );
    }
  });
});

/**
 * `box-shadow` is one property, so two `shadow-*` classes on one element is not a layered
 * shadow — the rule that comes later in `app-utilities.css` wins outright and the other
 * renders nothing at all. Same silent-no-op failure the check above exists for, one step
 * further along: the class is defined, it just never reaches the pixel.
 *
 * The FAB is how this surfaced (MICA-84). It carried `shadow-elevation-3` *and* a glow
 * class; the glow sorted later, so every FAB in the phone rendered a bare 24px bloom and
 * none of the M3 drop shadow it was asking for — which is most of why the halo read as
 * "too bright" rather than as elevation. Phone's three call buttons had it identically.
 * The fix in both cases is one composite class carrying both layers: `.shadow-fab`,
 * `.shadow-call-accept`, `.shadow-call-end`.
 *
 * Inherits `findClassUsages`'s blind spot, deliberately: a pairing formed inside a
 * `{expr}` — an elevation in the literal text and a glow returned from a helper — is
 * invisible to a regex scan, and two of those are still live (`ToastHost`'s success action
 * button, Camera's bouncing thumbnail). Both are dark or transient rather than a standing
 * halo, so they are not what MICA-84 was about; catching them needs a real parser, not a
 * looser regex that would start guessing which branch of a ternary is a class.
 */
function findShadowPairings(files: string[]): ClassUsage[] {
  const pairings: ClassUsage[] = [];
  const classAttrRe = /\bclass="((?:[^"\\]|\\.)*)"/g;

  for (const file of files) {
    const blankComment = (match: string) => '\n'.repeat((match.match(/\n/g) ?? []).length);
    const source = fs
      .readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, blankComment)
      .replace(/\/\*[\s\S]*?\*\//g, blankComment);
    const rel = path.relative(WEB_SRC, file);

    classAttrRe.lastIndex = 0;
    for (const match of source.matchAll(classAttrRe)) {
      const shadows = stripInterpolations(match[1])
        .split(/\s+/)
        .filter((token) => token.startsWith('shadow-'));
      if (shadows.length > 1) {
        pairings.push({
          file: rel,
          line: lineOf(source, match.index ?? 0),
          token: shadows.join(' ')
        });
      }
    }
  }

  return pairings;
}

describe('box-shadow does not compose across classes', () => {
  it('has no element carrying two shadow utilities', () => {
    const found = findShadowPairings(walk(WEB_SRC, ['.svelte']));

    if (found.length > 0) {
      const report = found.map((u) => `  ${u.file}:${u.line} — "${u.token}"`).join('\n');
      expect.fail(
        `${found.length} element(s) with more than one \`shadow-*\` class. \`box-shadow\` ` +
          `does not layer across classes, so only the rule sorting last in ` +
          `app-utilities.css renders and the other is silently dead. Compose both layers ` +
          `into one class, the way \`.shadow-fab\` does:\n${report}`
      );
    }
  });

  it('gives each composite one class carrying both the elevation and the bloom', () => {
    const css = fs.readFileSync(path.join(WEB_SRC, '..', '..', 'sdk', 'app-utilities.css'), 'utf8');

    for (const [name, bloom] of [
      ['shadow-fab', 'var(--color-primary-glow)'],
      ['shadow-call-accept', 'rgba(34, 197, 94, 0.18)'],
      ['shadow-call-end', 'rgba(239, 68, 68, 0.18)']
    ]) {
      const rule = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css);
      expect(rule, `.${name} declared in app-utilities.css`).not.toBeNull();
      expect(rule?.[1], `.${name} keeps its elevation`).toContain('var(--shadow-elevation-3)');
      expect(rule?.[1], `.${name} keeps its bloom`).toContain(bloom);
    }
  });
});

/**
 * A launcher tile's glyph has to be legible on the tile.
 *
 * `AppIcon.svelte` paints the tile with `manifest.color` and the glyph with an SVG whose
 * `stroke`/`fill` is `currentColor`, so the glyph takes whatever `color` is in scope. When
 * the manifest names no foreground class, that resolves all the way up to `Launcher`'s
 * `text-on-surface` — near-white in the dark scheme, which is right on a dark tile and
 * unreadable on a light one. Notes (`bg-yellow-400`) came out at 1.19:1 and Messages
 * (`bg-green-400`) at 1.35:1: not a subtle regression, a glyph nobody could see, and
 * painful to look at besides (MICA-88).
 *
 * Camera and Media had already met this and each fixed it in place; the failure is that
 * nothing generalised from them. This does — every manifest is checked against the color
 * its glyph will really inherit, read out of `app-utilities.css` rather than duplicated
 * here, so a palette value cannot drift out from under the numbers.
 *
 * "Really inherit" is the load-bearing part, and Messages is why. Fixing its *manifest*
 * changed nothing on screen: `Icon.svelte` defaulted its own `class` to
 * `text-on-surface h-8 w-8`, and a color on the SVG itself beats one inherited from the
 * tile around it.
 *
 * Which is the whole reason for the second check below. There were three competing answers
 * to "what color is an app's glyph" — the manifest (Camera, Media), the icon's own default
 * class (eight apps), and hardcoded `fill`s in the SVG (Snek) — and nothing had ever
 * decided between them. `class` replaces the default outright rather than merging, and
 * every caller outside the launcher passes its own size class, so those eight hardcoded
 * colors only ever applied on the launcher tile: the one place they were wrong.
 *
 * The rule now is that the **tile owns the glyph color** and the icon owns only its shape.
 * `AppIcon` already paints `manifest.color` around the glyph, and `currentColor` carries it
 * the rest of the way — on the tile, in the status bar, in the drawer, in the Store. So an
 * `Icon.svelte` default `class` may not name a `text-*` at all. That is a stricter rule
 * than measuring contrast and a simpler one, and it is what makes the measurement below
 * meaningful rather than something an icon can quietly override.
 *
 * Snek is the exception and stays one: its mark is two-tone black-and-red by design,
 * painted with literal `fill`s that must not follow the theme. An icon that paints itself
 * is skipped rather than measured.
 *
 * Skipped rather than passed when the tile color is not a plain palette literal (a themed
 * role, a gradient) or when the icon hardcodes its own `fill`, the way Snek does — there
 * is nothing to compare in either case, and guessing would be worse than declining.
 */
const CONTRAST_FLOOR = 3;

/**
 * Tiles already under the floor, with the ratio they are at today. A ratchet on the model
 * of `sdk/cef.test.ts`'s opacity budget: a new entry is a regression and fails, and an
 * entry that has been fixed goes stale and also fails, so the list cannot rot into room
 * for the next one.
 *
 * These are white-on-mid-tone-brand, the look every launcher has — legible, unlike the two
 * MICA-88 was about, but short of WCAG's 3:1 for a graphical object. Phone at 1.76 is the
 * one genuinely worth revisiting. Repainting seven brand colors is a launcher design
 * decision rather than a bug fix, so they are recorded rather than quietly changed.
 */
const BELOW_FLOOR: Record<string, number> = {
  'apps/blabber/manifest.ts': 2.14,
  'apps/hodlr/manifest.ts': 2.91,
  'apps/mail/manifest.ts': 2.84,
  'apps/marketplace/manifest.ts': 2.46,
  'apps/phone/manifest.ts': 1.76
};

/** `#rrggbb` → linear-light relative luminance, per WCAG 2. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `.bg-yellow-400 { background-color: #facc15 }` → `{ 'bg-yellow-400': '#facc15' }`. */
function loadPaletteLiterals(prop: 'background-color' | 'color'): Map<string, string> {
  const css = fs.readFileSync(path.join(WEB_SRC, '..', '..', 'sdk', 'app-utilities.css'), 'utf8');
  const rules = new RegExp(String.raw`\.([\w-]+)\s*\{\s*${prop}:\s*(#[0-9a-f]{6})\s*;?\s*\}`, 'gi');
  return new Map([...css.matchAll(rules)].map((m) => [m[1], m[2].toLowerCase()]));
}

describe('launcher tile contrast', () => {
  it('keeps every app glyph legible on its own tile', () => {
    const backgrounds = loadPaletteLiterals('background-color');
    const foregrounds = loadPaletteLiterals('color');

    // What the glyph inherits when a manifest names no foreground of its own: the
    // `text-on-surface` on `Launcher.svelte`'s root, whose dark-scheme literal is in app.css.
    const appCss = fs.readFileSync(path.join(WEB_SRC, '..', '..', 'sdk', 'app.css'), 'utf8');
    const onSurface = /--color-on-surface:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(appCss);
    expect(onSurface, '--color-on-surface declared in app.css').not.toBeNull();
    const inherited =
      '#' +
      onSurface!
        .slice(1, 4)
        .map((c) => Number(c).toString(16).padStart(2, '0'))
        .join('');

    const manifests = walk(path.join(WEB_SRC, 'apps'), ['.ts']).filter((f) =>
      f.endsWith('manifest.ts')
    );

    const failures: string[] = [];
    const measured = new Map<string, number>();
    for (const file of manifests) {
      const source = fs.readFileSync(file, 'utf8');
      const rel = path.relative(WEB_SRC, file);
      const declared = readTile(source);
      if (!declared?.bg) continue;

      const tile = backgrounds.get(declared.bg);
      // A themed role or anything that is not a flat palette literal: nothing to measure.
      if (!tile) continue;

      // An icon that paints itself — Snek's hardcoded black — does not inherit anything.
      const icon = path.join(path.dirname(file), 'Icon.svelte');
      if (
        fs.existsSync(icon) &&
        /(?:fill|stroke)="(?:#[0-9a-fA-F]{3,6}|black|white)"/.test(fs.readFileSync(icon, 'utf8'))
      )
        continue;

      // The tile's own foreground, or what `Launcher` hands down when it names none. An
      // icon cannot enter into it — the check below is what keeps that true. Since
      // MICA-91 the two roles are named rather than sniffed out of one string, so
      // "the manifest states no foreground" is now a fact this can read rather than infer.
      const glyph = (declared.fg && foregrounds.get(declared.fg)) || inherited;
      const ratio = contrast(tile, glyph);
      const recorded = BELOW_FLOOR[rel];

      if (recorded === undefined) {
        if (ratio < CONTRAST_FLOOR) {
          failures.push(
            `  ${rel} — glyph ${glyph} on tile ${tile} is ${ratio.toFixed(2)}:1 ` +
              `(floor ${CONTRAST_FLOOR}:1). Add a foreground class to the manifest's ` +
              `\`color\`, the way camera and media do.`
          );
        }
        continue;
      }

      measured.set(rel, ratio);
      if (ratio < recorded - 0.005) {
        failures.push(
          `  ${rel} — was ${recorded.toFixed(2)}:1, now ${ratio.toFixed(2)}:1. The ratchet ` +
            `only goes up; raise the tile's contrast or leave it where it was.`
        );
      }
    }

    for (const rel of Object.keys(BELOW_FLOOR)) {
      const ratio = measured.get(rel);
      if (ratio === undefined) {
        failures.push(`  ${rel} — listed in BELOW_FLOOR but no longer measured; delete the line.`);
      } else if (ratio >= CONTRAST_FLOOR) {
        failures.push(
          `  ${rel} — now ${ratio.toFixed(2)}:1, at or above the floor. Delete the line.`
        );
      }
    }

    if (failures.length > 0) {
      expect.fail(`${failures.length} launcher tile contrast problem(s):\n` + failures.join('\n'));
    }
  });
});

describe('an app icon owns its shape, not its color', () => {
  it('names no text color in an Icon default class', () => {
    const icons = walk(path.join(WEB_SRC, 'apps'), ['.svelte']).filter((f) =>
      f.endsWith('Icon.svelte')
    );
    expect(icons.length, 'found app icons to check').toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of icons) {
      const source = fs.readFileSync(file, 'utf8');
      const fallback = /class:\s*className\s*=\s*'([^']*)'/.exec(source)?.[1];
      const colors = (fallback ?? '').split(/\s+/).filter((t) => t.startsWith('text-'));
      if (colors.length > 0) {
        offenders.push(`  ${path.relative(WEB_SRC, file)} — "${colors.join(' ')}"`);
      }
    }

    if (offenders.length > 0) {
      expect.fail(
        `${offenders.length} app icon(s) hardcoding a text color in their default ` +
          `\`class\`. A color on the SVG beats the one inherited from the tile, so the ` +
          `manifest's \`color\` stops working — silently, and only on the launcher, since ` +
          `every other call site passes its own class. Size only; let \`currentColor\` ` +
          `carry the rest:\n${offenders.join('\n')}`
      );
    }
  });
});

/** A tag as it appears in Svelte markup, with its attribute text and where it starts. */
interface MarkupTag {
  name: string;
  kind: 'open' | 'close' | 'self';
  attrs: string;
  index: number;
}

/** HTML elements that close themselves whether or not the author wrote the slash. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr'
]);

/**
 * Every tag in a chunk of Svelte markup, in source order.
 *
 * A regex cannot do this: an attribute value holds `>` routinely — every arrow function in
 * an `onclick={() => …}` has one — so a scan that stops at the first `>` splits tags in half
 * and mis-reads the nesting. This walks the text instead, holding quote state and `{}` depth,
 * and only treats a `>` outside both as the end of a tag.
 */
function scanTags(source: string): MarkupTag[] {
  const tags: MarkupTag[] = [];
  const nameRe = /^<(\/?)([A-Za-z][\w.:-]*)/;

  for (let i = 0; i < source.length;) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    const name = nameRe.exec(source.slice(lt, lt + 64));
    if (!name) {
      i = lt + 1;
      continue;
    }

    let end = lt + name[0].length;
    let quote = '';
    let depth = 0;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      } else if (ch === '>' && depth === 0) {
        break;
      }
    }

    const selfClosing = source[end - 1] === '/' || VOID_ELEMENTS.has(name[2]);
    tags.push({
      name: name[2],
      kind: name[1] ? 'close' : selfClosing ? 'self' : 'open',
      attrs: source.slice(lt + name[0].length, source[end - 1] === '/' ? end - 1 : end),
      index: lt
    });
    i = end + 1;
  }

  return tags;
}

/** `[start, end)` of every `{#snippet …}` … `{/snippet}` region, so its tags can be skipped. */
function snippetRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const openings = [...source.matchAll(/\{#snippet\b/g)];
  for (const open of openings) {
    const close = source.indexOf('{/snippet}', open.index ?? 0);
    if (close !== -1) regions.push([open.index ?? 0, close + '{/snippet}'.length]);
  }
  return regions;
}

/** The statically-known class tokens on a tag, with `{expr}` spans dropped as elsewhere here. */
function classTokensOf(tag: MarkupTag): string[] {
  const literal = /\bclass="((?:[^"\\]|\\.)*)"/.exec(tag.attrs)?.[1];
  const template = /\bclass=\{`((?:[^`\\]|\\.)*)`\}/.exec(tag.attrs)?.[1];
  const text = literal ?? template ?? '';
  return stripInterpolations(text.replace(/\$\{/g, '{')).split(/\s+/).filter(Boolean);
}

/** Markup only — `<script>` and `<style>` stripped, comments blanked, line numbers preserved. */
function markupOf(source: string): string {
  const blank = (match: string) => '\n'.repeat((match.match(/\n/g) ?? []).length);
  return source
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/** The elements a component opens with — its depth-0 tags, `{#if}` branches included. */
function rootTags(markup: string): MarkupTag[] {
  const skip = snippetRegions(markup);
  const roots: MarkupTag[] = [];
  let depth = 0;
  for (const tag of scanTags(markup)) {
    if (skip.some(([from, to]) => tag.index >= from && tag.index < to)) continue;
    if (tag.kind === 'close') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) roots.push(tag);
    if (tag.kind === 'open') depth++;
  }
  return roots;
}

/** `import Foo from './components/Foo.svelte'` → `{ Foo: '/abs/path/Foo.svelte' }`. */
function svelteImports(file: string, source: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/\bimport\s+(\w+)\s+from\s+'([^']+\.svelte)'/g)) {
    if (!match[2].startsWith('.')) continue;
    imports.set(match[1], path.resolve(path.dirname(file), match[2]));
  }
  return imports;
}

/**
 * `Screen`'s content box is two boxes, and the inner one — the app's parent — is
 * `flex min-h-full flex-col` with a `height` of `auto` (see `sdk/ui/Screen.svelte`, whose
 * comment spells out the contract, and AGENTS.md §5). A percentage height needs a definite
 * parent to resolve against, so a child that opens with `h-full` gets `auto` instead: the
 * column is exactly as tall as its content, `flex-1` inside it has no leftover space to
 * claim, and any `overflow-y-auto` under it never engages.
 *
 * It fails silently and only under enough content, which is what makes it worth a static
 * check. MICA-89 was the expensive version: Blabber's DM composer, last child of such a
 * column, walked ~82px down the screen per message sent until it left the bottom edge.
 *
 * Only the *root* of a direct child is checked — the boundary where the contract applies.
 * `h-full` deeper inside an app is fine, because by then some ancestor has a real height.
 */
describe("Screen's height contract", () => {
  it('has no direct child of the content box filling with a percentage height', () => {
    const files = walk(WEB_SRC, ['.svelte']);
    const offenders: string[] = [];

    /**
     * The root tags of `<Foo />`, each carried with the file and markup it was read from so
     * it can be reported at its own line. Followed through a component whose own root is
     * another component, since that one inherits the contract in turn.
     */
    interface Root {
      tag: MarkupTag;
      file: string;
      markup: string;
    }

    const rootsOf = (file: string, seen = new Set<string>()): Root[] => {
      if (seen.has(file) || !fs.existsSync(file)) return [];
      seen.add(file);
      const source = fs.readFileSync(file, 'utf8');
      const markup = markupOf(source);
      const imports = svelteImports(file, source);
      return rootTags(markup).flatMap((tag) => {
        const nested = imports.get(tag.name);
        return nested ? rootsOf(nested, seen) : [{ tag, file, markup }];
      });
    };

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const markup = markupOf(source);
      const rel = path.relative(WEB_SRC, file);
      const imports = svelteImports(file, source);
      const skip = snippetRegions(markup);
      const tags = scanTags(markup);

      for (let i = 0; i < tags.length; i++) {
        if (tags[i].name !== 'Screen' || tags[i].kind !== 'open') continue;

        // Walk this `<Screen>`'s span, collecting the tags that sit at its own depth.
        let depth = 0;
        for (let j = i + 1; j < tags.length; j++) {
          const tag = tags[j];
          if (tag.kind === 'close') {
            if (depth === 0) break;
            depth--;
            continue;
          }
          const inSnippet = skip.some(([from, to]) => tag.index >= from && tag.index < to);
          if (depth === 0 && !inSnippet) {
            // A component child hands the contract to whatever *it* opens with.
            const child = imports.get(tag.name);
            const roots = child ? rootsOf(child) : [{ tag, file, markup }];
            for (const root of roots) {
              if (!classTokensOf(root.tag).includes('h-full')) continue;
              offenders.push(
                `  ${path.relative(WEB_SRC, root.file)}:${lineOf(root.markup, root.tag.index)}` +
                  `${child ? ` — <${tag.name}> in ${rel}` : ''}`
              );
            }
          }
          if (tag.kind === 'open') depth++;
        }
      }
    }

    if (offenders.length > 0) {
      expect.fail(
        `${offenders.length} root(s) of a \`Screen\` child filling with \`h-full\`. Fill ` +
          `with \`min-h-0 flex-1\` instead — \`flex-1\` takes the leftover height and ` +
          `\`min-h-0\` lets it shrink to that share rather than to its own ` +
          `content:\n${offenders.join('\n')}`
      );
    }
  });
});

/**
 * The other half of the same contract, and the half that is easy to get wrong while looking
 * right: a `Screen` child that fills with `flex-1` and has **no** `min-h-0`.
 *
 * A flex item's default `min-height: auto` resolves to its own content's minimum size, so
 * `flex-1` alone claims the leftover space and then refuses to give any of it back — the
 * item is sized by its content the moment its content is the larger of the two. A view with
 * nothing but a scrolling list under it never notices, because a box with `overflow-y-auto`
 * is exempt from that default and can shrink to nothing. A view with fixed chrome does
 * notice, and it fails in the most expensive way there is: only under enough content, and
 * only as a slow drift rather than a break.
 *
 * That is what MICA-89 was, twice. Blabber's DM composer walked ~82px per message sent
 * once the thread passed one screen; the core Messages composer sat 4000px below the
 * visible screen and had presumably always been there.
 *
 * Scoped to roots that actually contain a scroll region, deliberately. A `flex-1` root with
 * no scroller under it has nothing to divide up, so `min-h-0` would be noise — and a root
 * whose content genuinely exceeds the screen still overflows to `Screen`'s own scroller,
 * which is what a feed wants.
 */
describe("Screen's fill contract", () => {
  it('has no filling child that would still be sized by its content', () => {
    const files = walk(WEB_SRC, ['.svelte']);
    const offenders: string[] = [];

    const scrolls = (tag: MarkupTag) =>
      classTokensOf(tag).some((t) => t === 'overflow-y-auto' || t === 'overflow-auto');

    /** Every tag in a component, scroll regions inside the components *it* renders included. */
    const scrollsAnywhere = (file: string, seen: Set<string>): boolean => {
      if (seen.has(file) || !fs.existsSync(file)) return false;
      seen.add(file);
      const source = fs.readFileSync(file, 'utf8');
      const imports = svelteImports(file, source);
      return scanTags(markupOf(source)).some(
        (tag) =>
          scrolls(tag) || (imports.has(tag.name) && scrollsAnywhere(imports.get(tag.name)!, seen))
      );
    };

    /**
     * Does the subtree this tag opens contain a box that scrolls itself?
     *
     * Follows component tags as well as elements: the core Messages thread keeps its
     * scroller inside `MessageThread`, one file away from the root that has to shrink for
     * it — which is exactly the case this check exists for, and exactly the one a
     * same-file scan misses.
     */
    const wrapsAScroller = (
      tags: MarkupTag[],
      from: number,
      imports: Map<string, string>
    ): boolean => {
      let depth = 0;
      for (let i = from; i < tags.length; i++) {
        const tag = tags[i];
        if (tag.kind === 'close') {
          if (--depth <= 0) break;
          continue;
        }
        if (i > from) {
          const child = imports.get(tag.name);
          if (scrolls(tag) || (child && scrollsAnywhere(child, new Set()))) return true;
        }
        if (tag.kind === 'open') depth++;
      }
      return false;
    };

    /** The root tags of a component, paired with the file and markup they came from. */
    const rootsOf = (file: string): Array<{ tag: MarkupTag; file: string; markup: string }> => {
      if (!fs.existsSync(file)) return [];
      const markup = markupOf(fs.readFileSync(file, 'utf8'));
      return rootTags(markup).map((tag) => ({ tag, file, markup }));
    };

    const flag = (
      root: { tag: MarkupTag; file: string; markup: string },
      tags: MarkupTag[],
      imports: Map<string, string>
    ) => {
      const tokens = classTokensOf(root.tag);
      if (!tokens.includes('flex-1') || tokens.includes('min-h-0')) return;
      const at = tags.findIndex((t) => t.index === root.tag.index);
      if (at < 0 || !wrapsAScroller(tags, at, imports)) return;
      offenders.push(
        `  ${path.relative(WEB_SRC, root.file)}:${lineOf(root.markup, root.tag.index)} — ` +
          `"${tokens.join(' ')}"`
      );
    };

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const markup = markupOf(source);
      const imports = svelteImports(file, source);
      const skip = snippetRegions(markup);
      const tags = scanTags(markup);

      for (let i = 0; i < tags.length; i++) {
        if (tags[i].name !== 'Screen' || tags[i].kind !== 'open') continue;

        let depth = 0;
        for (let j = i + 1; j < tags.length; j++) {
          const tag = tags[j];
          if (tag.kind === 'close') {
            if (depth === 0) break;
            depth--;
            continue;
          }
          const inSnippet = skip.some(([from, to]) => tag.index >= from && tag.index < to);
          if (depth === 0 && !inSnippet) {
            const child = imports.get(tag.name);
            if (child) {
              const childSource = fs.readFileSync(child, 'utf8');
              const childTags = scanTags(markupOf(childSource));
              const childImports = svelteImports(child, childSource);
              for (const root of rootsOf(child)) flag(root, childTags, childImports);
            } else {
              flag({ tag, file, markup }, tags, imports);
            }
          }
          if (tag.kind === 'open') depth++;
        }
      }
    }

    if (offenders.length > 0) {
      expect.fail(
        `${offenders.length} \`Screen\` child root(s) filling with \`flex-1\` and no ` +
          `\`min-h-0\`, each wrapping a box that is meant to scroll itself. Without ` +
          `\`min-h-0\` the root is sized by its content instead of by its share, the ` +
          `scroller inside it never engages, and anything anchored below it drifts off the ` +
          `bottom of the screen. Add \`min-h-0\`:\n${offenders.join('\n')}`
      );
    }
  });
});
