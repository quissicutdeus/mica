// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stylelint from 'stylelint';
import { unparsedStylesheets } from './addon.js';
import { cssColorHits, inlineStyleColorHits } from './cef.js';
import { screenFillViolations, screenHeightViolations } from './screen.js';
import cefFloor from './stylelint.config.js';

/**
 * MICA-312. The parts of `sdk/checks/` whose failure would be silence, made to fire.
 *
 * The scans themselves are driven by `utilityClasses.test.ts`, `cef.test.ts` and the planted
 * template in `addonTemplate.test.ts`. What is here is each way the checker could stop
 * checking something while still reporting a pass.
 */

describe('a stylesheet stylelint did not read', () => {
  const CSS = '.a:has(.b) {\n  color: red;\n}\n';

  const lint = async (config: stylelint.Config) => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-checks-'));
    try {
      const file = join(dir, 'planted.css');
      writeFileSync(file, CSS);
      const { results } = await stylelint.lint({
        files: [file],
        config,
        configBasedir: process.cwd()
      });
      return { file, results };
    } finally {
      // `lint` has read the file by the time it resolves; the path is all that is kept.
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const read = () => CSS;

  it('is named when a markup syntax swallowed it, as `postcss-html` did here until MICA-312', async () => {
    const { file, results } = await lint({ ...cefFloor, customSyntax: 'postcss-html' });
    // The failure this exists for: a result, no warnings, and nothing checked.
    expect(results).toHaveLength(1);
    expect(results[0].warnings).toEqual([]);
    expect(unparsedStylesheets(results, read)).toEqual([file]);
  });

  it('is not named once the shared config reads it, and the floor fires', async () => {
    const { results } = await lint(cefFloor);
    expect(unparsedStylesheets(results, read)).toEqual([]);
    expect(results[0].warnings.map((w) => w.text).join('\n')).toMatch(/"css-has"/);
  });

  it('is named when a result carries nothing to tell, rather than assumed read', () => {
    expect(unparsedStylesheets([{ source: '/x.css' }], read)).toEqual(['/x.css']);
    expect(unparsedStylesheets([{ source: '/x.css', ignored: true }], read)).toEqual(['/x.css']);
  });

  it('leaves alone a file with no CSS in it to read', () => {
    expect(unparsedStylesheets([{ source: '/x.css' }], () => '/* only a comment */\n')).toEqual([]);
    expect(unparsedStylesheets([{ source: '/X.svelte' }], () => '<p>no style block</p>')).toEqual(
      []
    );
  });
});

describe('colour syntax past Chromium 103', () => {
  it('finds relative colour syntax and color-mix() in a stylesheet, at their lines', () => {
    const css = [
      '/* rgb(from red r g b) in a comment is prose */',
      '.a { color: rgb(from red r g b); }',
      '.b { color: hsl( from var(--x) h s l); }',
      '.c { color: color-mix(in srgb, red, blue); }',
      '.d { color: rgb(1 2 3); }'
    ].join('\n');
    expect(cssColorHits(css)).toEqual([
      { line: 2, hit: 'rgb(from' },
      { line: 3, hit: 'hsl( from' },
      { line: 4, hit: 'color-mix(' }
    ]);
  });

  it('finds it in an inline style=, where PostCSS never reaches', () => {
    expect(inlineStyleColorHits('<p>a</p>\n<p style="color: rgb(from red r g b)">b</p>')).toEqual([
      { line: 2, hit: 'rgb(from' }
    ]);
  });
});

describe('a Screen child imported from a file that is not there', () => {
  const files: Record<string, string> = {
    '/app/App.svelte': [
      '<script lang="ts">',
      "  import Gone from './Gone.svelte';",
      '</script>',
      '<Screen title="x">',
      '  <Gone />',
      '</Screen>'
    ].join('\n')
  };
  const read = (file: string) => files[file];

  it.each([
    ['height', screenHeightViolations],
    ['fill', screenFillViolations]
  ])('stops the %s check, instead of checking less', (_label, check) => {
    expect(() => check(['/app/App.svelte'], read)).toThrow(
      '/app/App.svelte imports /app/Gone.svelte, which does not exist'
    );
  });

  it.each([
    ['height', screenHeightViolations],
    ['fill', screenFillViolations]
  ])('stops the %s check on a file it was handed that is not there', (_label, check) => {
    expect(() => check(['/app/Missing.svelte'], read)).toThrow(
      '/app/Missing.svelte does not exist'
    );
  });
});
