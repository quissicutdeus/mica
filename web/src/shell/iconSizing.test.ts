// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An icon in the shell whose box is one of the icon tokens takes that token's class, not a
 * raw `h-N w-N` (MICA-420). `size-icon-sm`/`-md`/`-lg` are `--size-icon-*` in `sdk/app.css`
 * (1rem, 1.25rem, 1.5rem), which is `h-4 w-4`, `h-5 w-5` and `h-6 w-6` on the spacing scale;
 * the raw pair draws the same box today and stops matching the moment a token moves. A
 * size with no token (`h-3.5 w-3.5`, a battery's `h-4 w-8`) is left alone.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELL = path.dirname(fileURLToPath(import.meta.url));

/** Spacing step to the token that draws the same square. */
const TOKEN_OF_STEP: Record<string, string> = {
  '4': 'size-icon-sm',
  '5': 'size-icon-md',
  '6': 'size-icon-lg'
};

/** An icon component (`SearchIcon`, `Icon`) or a bare `<svg>`, attributes and all. */
const ICON_TAG = /<(\w*Icon|svg)\b[^>]*?>/gs;

const svelteFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return svelteFiles(full);
    return entry.name.endsWith('.svelte') ? [full] : [];
  });

/** Every icon tag in `source` drawn as a raw square that a token already names. */
const rawTokenSizedIcons = (source: string): string[] =>
  [...source.matchAll(ICON_TAG)].flatMap((match) => {
    const tag = match[0];
    const h = /(?<![\w-])h-(\d+)(?![.\w])/.exec(tag)?.[1];
    const w = /(?<![\w-])w-(\d+)(?![.\w])/.exec(tag)?.[1];
    if (!h || h !== w || !TOKEN_OF_STEP[h]) return [];
    const line = source.slice(0, match.index).split('\n').length;
    return [`${line}: h-${h} w-${w} is ${TOKEN_OF_STEP[h]}`];
  });

describe('rawTokenSizedIcons', () => {
  it('finds a raw square that a token names, in either order and across lines', () => {
    expect(rawTokenSizedIcons('<SearchIcon class="h-4 w-4" />')).toEqual([
      '1: h-4 w-4 is size-icon-sm'
    ]);
    expect(rawTokenSizedIcons('<svg\n  class="w-6 shrink-0 h-6"\n>')).toEqual([
      '1: h-6 w-6 is size-icon-lg'
    ]);
  });

  it('leaves a size with no token, a non-square, and a token class alone', () => {
    expect(rawTokenSizedIcons('<TrashIcon class="h-3.5 w-3.5" />')).toEqual([]);
    expect(rawTokenSizedIcons('<BatteryIcon class="h-4 w-8" />')).toEqual([]);
    expect(rawTokenSizedIcons('<CheckIcon class="h-8 w-8" />')).toEqual([]);
    expect(rawTokenSizedIcons('<SearchIcon class="size-icon-sm" />')).toEqual([]);
    expect(rawTokenSizedIcons('<div class="h-4 w-4"></div>')).toEqual([]);
    expect(rawTokenSizedIcons('<svg class="min-h-4 h-4.5 w-4" />')).toEqual([]);
  });
});

/**
 * TEMPORARY: another lane holds `AppDrawer.svelte` until MICA-419 lands; its search icon
 * moves to the token then, and this list goes with it. Keyed to the file and the exact tag,
 * never a line number, so an edit elsewhere in the file cannot turn the exemption red — and
 * a change to the tag itself drops it out of the exemption and back into the scan.
 */
const PENDING_MICA_419: Record<string, string[]> = {
  'AppDrawer.svelte': ['<SearchIcon class="text-on-surface-variant h-4 w-4" />']
};

/** `source` with each exempt tag blanked out; same line count, so every other hit keeps its line. */
const withoutPending = (file: string, source: string): string =>
  (PENDING_MICA_419[file] ?? []).reduce((text, tag) => text.replace(tag, ''), source);

describe('shell icons use the icon tokens (MICA-420)', () => {
  it('sizes no shell icon with a raw square a token already names', () => {
    const offenders = svelteFiles(SHELL).flatMap((file) => {
      const rel = path.relative(SHELL, file);
      return rawTokenSizedIcons(withoutPending(rel, fs.readFileSync(file, 'utf8'))).map(
        (hit) => `${rel}:${hit}`
      );
    });
    expect(offenders).toEqual([]);
  });
});
