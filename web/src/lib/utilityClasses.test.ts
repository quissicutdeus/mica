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
    const filePath = path.join(WEB_SRC, name);
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

/**
 * Every statically-known class token from an app manifest's `color` field.
 *
 * `AppIcon` interpolates `manifest.color` directly into a `class` (see `sdk/manifest.ts`),
 * so a stale or typo'd token there is exactly the same silent-no-op failure a `.svelte`
 * `class="..."` typo is — it just lives one file away from where it renders. Narrow and
 * literal on purpose: only a plain single- or double-quoted string literal assigned to
 * `color:` is read. A template literal or any other expression is skipped rather than
 * guessed at — there is nothing statically knowable to check in that case, the same
 * reasoning `stripInterpolations` applies to a Svelte `{expr}`.
 */
function findManifestColorUsages(files: string[]): ClassUsage[] {
  const usages: ClassUsage[] = [];
  const colorFieldRe = /\bcolor:\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(WEB_SRC, file);

    colorFieldRe.lastIndex = 0;
    for (const match of source.matchAll(colorFieldRe)) {
      const line = lineOf(source, match.index ?? 0);
      for (const token of match[2].split(/\s+/).filter(Boolean)) {
        usages.push({ file: rel, line, token });
      }
    }
  }

  return usages;
}

describe('app-utilities.css coverage', () => {
  it('has a rule for every statically-known class token used in .svelte markup and app manifest colors', () => {
    const defined = loadDefinedClasses();
    const svelteFiles = walk(WEB_SRC, ['.svelte']);
    const manifestFiles = walk(path.join(WEB_SRC, 'apps'), ['.ts']).filter((f) =>
      f.endsWith('manifest.ts')
    );
    const usages = [...findClassUsages(svelteFiles), ...findManifestColorUsages(manifestFiles)];

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
        .filter((token) => /^shadow-/.test(token));
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
    const css = fs.readFileSync(path.join(WEB_SRC, 'app-utilities.css'), 'utf8');

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
  const css = fs.readFileSync(path.join(WEB_SRC, 'app-utilities.css'), 'utf8');
  const rules = new RegExp(String.raw`\.([\w-]+)\s*\{\s*${prop}:\s*(#[0-9a-f]{6})\s*;?\s*\}`, 'gi');
  return new Map([...css.matchAll(rules)].map((m) => [m[1], m[2].toLowerCase()]));
}

describe('launcher tile contrast', () => {
  it('keeps every app glyph legible on its own tile', () => {
    const backgrounds = loadPaletteLiterals('background-color');
    const foregrounds = loadPaletteLiterals('color');

    // What the glyph inherits when a manifest names no foreground of its own: the
    // `text-on-surface` on `Launcher.svelte`'s root, whose dark-scheme literal is in app.css.
    const appCss = fs.readFileSync(path.join(WEB_SRC, 'app.css'), 'utf8');
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
      const color = /\bcolor:\s*'([^']*)'/.exec(source);
      if (!color) continue;

      const tokens = color[1].split(/\s+/).filter(Boolean);
      const tile = tokens.map((t) => backgrounds.get(t)).find(Boolean);
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
      // icon cannot enter into it — the check below is what keeps that true.
      const glyph = tokens.map((t) => foregrounds.get(t)).find(Boolean) ?? inherited;
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
      const colors = (fallback ?? '').split(/\s+/).filter((t) => /^text-/.test(t));
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
