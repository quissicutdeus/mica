// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every build-time identifier this tree injects has to be substituted in an add-on's bundle
 * too — MICA-170.
 *
 * ## The incident this exists for
 *
 * `web/vite.config.ts` has a `define` block for `__GOS_VERSION__` and
 * `__GOS_BUILD_INFO__`. `web/vite.addon.config.ts` had none, so both identifiers
 * survived verbatim into all four shipped `core: false` bundles. Inside the sandboxed
 * add-on iframe they are undeclared, `sdk/version.ts`'s `typeof` guards therefore held, and
 * every published add-on read the fallback — `GOS_VERSION === '1.0.0'` and
 * `GOS_BUILD_INFO === 'v1.0.0-dev'` — on every server, forever. A plausible number, not
 * an obvious error, which is what let it stand.
 *
 * ## Why this test is a source read and not a bundle read
 *
 * The bundles live in `web/public/addons/`, which is gitignored and only exists once
 * `scripts/build-addons.mjs` has run. A suite that globbed that directory would find
 * nothing on a clean checkout and report a pass — the fail-open shape AGENTS.md §9 names,
 * and worse than no check because it reads as coverage.
 *
 * So the coverage is split in two, and both halves are needed:
 *
 *   1. **This file**, which reads two tracked sources and so runs identically everywhere:
 *      it fails the moment a new `__GOS_*__` global is declared and wired into the shell
 *      build without being given a deliberate value for add-ons. That is the mistake that
 *      actually happened, and it is caught here before anyone reaches a build.
 *   2. **`noUnsubstitutedDefines()` in `vite.addon.config.ts`**, which reads the finished
 *      chunk text and fails the build that produced it. It is the one that can see the real
 *      artifact, and it cannot be silent while a bad bundle exists, because it runs exactly
 *      when a bundle is produced.
 *
 * What neither half checks: whether the *value* an add-on is given is the right one. That
 * is a judgement — recorded in `sdk/version.ts` and in the `define` block's own comment —
 * and no grep can hold it.
 */

// MICA-172: `__dirname` is `sdk/` at the repo root now. One hop up is the repo root,
// and the phone it reasons about is its sibling `web/`.
const WEB_DIR = join(__dirname, '..', 'web');

const AMBIENT_DECLARATIONS = join(WEB_DIR, 'src', 'vite-env.d.ts');
const ADDON_CONFIG = join(WEB_DIR, 'vite.addon.config.ts');

/** `declare const __GOS_VERSION__: string;` → `__GOS_VERSION__`. */
const declaredIdentifiers = (source: string): string[] =>
  [...source.matchAll(/declare\s+const\s+(__GOS_[A-Za-z0-9_]*__)\s*:/g)].map((m) => m[1]).sort();

/**
 * The contents of the config's `define: { … }` block.
 *
 * Read from the block rather than from the file as a whole on purpose: both identifiers are
 * named in prose in the comments around it, so a whole-file search would find them there and
 * report a config that defines nothing as fully covered.
 */
const defineBlock = (source: string): string => {
  const m = /\bdefine:\s*\{([^{}]*)\}/.exec(source);
  return m ? m[1] : '';
};

describe('the add-on build substitutes every injected identifier', () => {
  const declared = declaredIdentifiers(readFileSync(AMBIENT_DECLARATIONS, 'utf8'));
  const block = defineBlock(readFileSync(ADDON_CONFIG, 'utf8'));

  it('read both files, so the comparison below is not vacuous', () => {
    // Either parse going blind — the `.d.ts` reformatted, the block gaining a nested object
    // the `[^{}]*` above cannot span — would make every difference disappear and leave this
    // reading as a clean bill of health.
    expect(
      declared.length,
      `no \`declare const __GOS_*__\` found in ${AMBIENT_DECLARATIONS} — if the ambient ` +
        'declarations moved, point this test at their new home rather than deleting it'
    ).toBeGreaterThan(0);
    expect(
      block.trim(),
      `no \`define: { … }\` block parsed out of ${ADDON_CONFIG}. If the block gained a ` +
        'nested object, widen the matcher — an empty parse here would pass this suite while ' +
        'shipping unsubstituted identifiers to every add-on.'
    ).not.toBe('');
  });

  it.each(['__GOS_VERSION__', '__GOS_BUILD_INFO__'])(
    'still declares %s, so this test is checking the identifiers it was written for',
    (name) => {
      // Pinned by name, not just counted: dropping one of these from `vite-env.d.ts` while
      // leaving `sdk/version.ts` reading it would shrink `declared` and quietly narrow what
      // the `each` below covers.
      expect(declared).toContain(name);
    }
  );

  it('gives each one a value in vite.addon.config.ts', () => {
    const missing = declared.filter((name) => !new RegExp(`\\b${name}\\s*:`).test(block));

    expect(
      missing,
      `${missing.join(', ')} is injected by the shell build but has no entry in the add-on ` +
        "build's `define` block. Left undefined it survives into every add-on bundle, where " +
        'the identifier is undeclared and the fallback in `sdk/version.ts` wins silently — ' +
        'MICA-170. Decide what an add-on should see (it is not automatically what the ' +
        'shell sees; a bundle is compiled once and run by whatever phone installs it) and ' +
        'add it there.'
    ).toEqual([]);
  });
});
