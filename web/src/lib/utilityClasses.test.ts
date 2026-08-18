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
 * - A fully dynamic `class={someVar}` binding (an icon's `class` prop, a manifest's
 *   `color` field used as a class elsewhere) isn't checked — there's no literal text to
 *   check statically, by construction.
 * - Only `.svelte` files are scanned. `.ts` files that hand a class *string* to a
 *   component (`sdk/manifest.ts`'s `color`) are out of scope for the same reason.
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

describe('app-utilities.css coverage', () => {
  it('has a rule for every statically-known class token used in .svelte markup', () => {
    const defined = loadDefinedClasses();
    const svelteFiles = walk(WEB_SRC, ['.svelte']);
    const usages = findClassUsages(svelteFiles);

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
