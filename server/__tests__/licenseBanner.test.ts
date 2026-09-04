// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// @ts-expect-error -- a plain .js build module with a hand-written .d.ts beside it.
import { LICENSE_BANNER } from '../../scripts/license-banner.js';

/**
 * Every bundle this repo emits carries its licence notice (MICA-192).
 *
 * Built output is the distribution case the licence cares most about, and it shipped with
 * nothing: a server owner handed `dist/` had no way to tell what the code was, who held the
 * copyright, under what terms, or where the source lived.
 *
 * This suite exists because the config was twice not the thing that mattered. Vite 8 bundles
 * rolldown, which silently ignores `build.rollupOptions.output.banner` — set it and 28
 * chunks are unchanged, with no warning anywhere. And a `generateBundle` hook at the normal
 * stage is overwritten by every post-stage hook that prepends to `chunk.code`: Vite's own
 * `__vite__mapDeps` prologue and the add-on config's CSS injector both do, so the banner
 * landed on line 3 of five files while looking perfect in the other twenty-nine.
 *
 * Only the emitted files answer the question, and they are checked by
 * `scripts/check-license-banner.js` at the end of the build rather than here: `verify` runs
 * `unit` *before* `build`, so a test reading `dist/` finds nothing in a clean checkout and
 * skips — silence that reads as a pass. What is left here is what can be asserted without a
 * build, and none of it can skip.
 */

const ROOT = resolve(__dirname, '../..');

describe('the licence banner on built output', () => {
  it('is a `/*!` comment, which is what a minifier keeps', () => {
    // `/*` is dropped by every minifier worth the name; `/*!` is the convention they honour.
    // Without this the banner survives only by whichever minify flags a build happens to
    // carry, which is not a property anyone would notice losing.
    expect(LICENSE_BANNER.startsWith('/*!')).toBe(true);
  });

  it('names the four things a reader of dist/ needs', () => {
    expect(LICENSE_BANNER).toContain('micaOS');
    expect(LICENSE_BANNER).toContain('Copyright (C)');
    expect(LICENSE_BANNER).toContain('AGPL-3.0-or-later');
    expect(LICENSE_BANNER).toContain('https://github.com/quissicutdeus/mica');
  });

  /**
   * The three builds that emit JavaScript, each of which had to be wired separately: esbuild
   * for the game client and server, and two Vite configs — the phone and the add-on bundles.
   * A fourth would be missed silently, so this names the ones that exist rather than trusting
   * that the list has not grown.
   */
  it.each([
    ['build/build-bundle.js', 'LICENSE_BANNER'],
    ['web/vite.config.ts', 'licenseBanner()'],
    ['web/vite.addon.config.ts', 'licenseBanner()']
  ])('%s applies it', (file, marker) => {
    expect(readFileSync(join(ROOT, file), 'utf8')).toContain(marker);
  });
});
