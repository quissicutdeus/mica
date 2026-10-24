// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The e2e suite runs once, in the default scheme, and runs `THEME_SPECS` a second time in
 * light (`web/playwright.config.ts`). That is worth ~30s a run, and it is only safe while
 * the list stays honest.
 *
 * It used to run everything twice. Nothing in the suite compares pixels — the specs assert
 * on the DOM and on geometry, both identical between schemes — so twenty-seven of the
 * twenty-nine spec files were asserting the same things a second time. The two that are
 * not are the ones that read a `--color-*` custom property off the computed style.
 *
 * The risk that trade introduces is precise and worth naming: somebody adds a colour
 * assertion to an untagged spec, and it silently runs in one scheme only — a light-mode
 * regression that no gate would catch, which is exactly what the brute-force matrix was
 * buying. So the list is checked rather than trusted. A spec that reads a computed colour
 * and is not in `THEME_SPECS` fails here, in a unit test that costs milliseconds, rather
 * than never.
 */

/** `web/`, three levels up from `web/src/lib/this-file.ts`. */
const WEB = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const E2E = path.join(WEB, 'e2e');

/**
 * Properties that never hold a colour. Kept tight on purpose: anything not named here —
 * `color`, `border*`, `*shadow`, `fill`, `stroke`, `cursor`, a custom property — counts.
 */
const NOT_A_COLOUR =
  /font(?:-[a-z]+)*|text-(?:overflow|align)|white-space|overflow(?:-[xy])?|display|visibility|position|opacity|z-index|(?:min-|max-)?(?:width|height)|line-height|letter-spacing/;

/**
 * Reading a colour back out of the DOM — the only thing that can differ between schemes.
 *
 * A `toHaveCSS` whose first argument is a string literal naming a property above is not a
 * colour read (MICA-442's font-weight check tripped it); every other `toHaveCSS` still is.
 */
const READS_A_COLOUR = new RegExp(
  [
    '--color-',
    String.raw`getPropertyValue\(\s*['"\x60]--`,
    // `\s*` inside the lookahead: outside it, `\s*` backtracks to match less whitespace and
    // the lookahead then sees a space instead of the quote, so a wrapped call would count.
    String.raw`toHaveCSS\((?!\s*(?<quote>['"\x60])(?:${NOT_A_COLOUR.source})\k<quote>)`,
    'backgroundColor',
    'getComputedStyle'
  ].join('|')
);

function specFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) specFiles(full, out);
    else if (entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** The globs `playwright.config.ts` declares, read as text so nothing has to import it. */
function themeSpecs(): string[] {
  const config = fs.readFileSync(path.join(WEB, 'playwright.config.ts'), 'utf8');
  const declaration = /const THEME_SPECS = \[([^\]]*)\]/.exec(config);
  expect(declaration, 'THEME_SPECS is declared in playwright.config.ts').not.toBeNull();
  return [...declaration![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** `**‍/theme-modes.spec.ts` matches `e2e/theme-modes.spec.ts`. Basename is all that varies here. */
const matches = (globs: string[], file: string) =>
  globs.some((glob) => path.basename(glob) === path.basename(file));

describe('READS_A_COLOUR', () => {
  /**
   * The regex both ways. A `toHaveCSS` of a property that cannot hold a colour is not a
   * colour read; every other `toHaveCSS` is, including one whose property is not a literal.
   */
  it.each([
    ["toHaveCSS('font-weight', '600')", false],
    ['toHaveCSS("text-overflow", "ellipsis")', false],
    ['toHaveCSS(\n      `opacity`, "1")', false],
    ["toHaveCSS('max-height', '0px')", false],
    ["toHaveCSS('color', 'rgb(0, 0, 0)')", true],
    ["toHaveCSS('background-color', 'rgb(0, 0, 0)')", true],
    ["toHaveCSS('border-top-color', 'rgb(0, 0, 0)')", true],
    ["toHaveCSS('border-width', '1px')", true],
    ["toHaveCSS('box-shadow', 'none')", true],
    ["toHaveCSS('fill', 'rgb(0, 0, 0)')", true],
    ["toHaveCSS('--color-x', '#000')", true],
    ['toHaveCSS(prop, value)', true],
    ['toHaveCSS(`font-${part}`, value)', true],
    ["toHaveCSS('text-decoration-color', 'rgb(0, 0, 0)')", true],
    ["toHaveCSS('text-shadow', 'none')", true]
  ] as const)('%j → %s', (source, reads) => {
    expect(READS_A_COLOUR.test(source)).toBe(reads);
  });
});

describe('e2e colour-scheme coverage', () => {
  it('runs every colour-asserting spec in both schemes', () => {
    const globs = themeSpecs();
    const files = specFiles(E2E);
    expect(files.length, 'found e2e specs to check').toBeGreaterThan(20);

    const unguarded = files
      .filter((file) => READS_A_COLOUR.test(fs.readFileSync(file, 'utf8')))
      .filter((file) => !matches(globs, file))
      .map((file) => `  ${path.relative(WEB, file)}`);

    if (unguarded.length > 0) {
      expect.fail(
        `${unguarded.length} spec(s) read a colour back out of the DOM but run in one ` +
          `scheme only. Light mode inverts every surface role, so an assertion like that ` +
          `is exactly what the second project exists for — add the spec to THEME_SPECS in ` +
          `web/playwright.config.ts:\n${unguarded.join('\n')}`
      );
    }
  });

  it('lists no spec that has stopped asserting on colour', () => {
    // The other direction, so the list cannot quietly grow into "run everything twice"
    // again one forgotten entry at a time.
    const files = specFiles(E2E);
    const stale = themeSpecs()
      .filter((glob) => {
        const file = files.find((f) => path.basename(f) === path.basename(glob));
        return !file || !READS_A_COLOUR.test(fs.readFileSync(file, 'utf8'));
      })
      .map((glob) => `  ${glob}`);

    if (stale.length > 0) {
      expect.fail(
        `${stale.length} entr(y/ies) in THEME_SPECS no longer name a spec that reads a ` +
          `colour. Each one costs a second full run of that file for nothing — delete ` +
          `it:\n${stale.join('\n')}`
      );
    }
  });
});
