// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The phone has one corner radius, and it is spelled as a role.
 *
 * Every rectangle takes `rounded-box`, every small labelled thing `rounded-chip`, and
 * `rounded-full` is reserved for what is genuinely round — avatars, count badges, toggle
 * knobs, the home indicator. The sizes those roles are cut from stay in `app.css`.
 *
 * The rule is here because the alternative was proven not to work. `--radius-xl` is 28px,
 * which is the right shape for a bottom sheet and a circle on a 44px list row, and the Store
 * had both: catalog rows rendered as pills beside launcher tiles that rendered as squares,
 * from markup that looked identical at each call site. Nothing said they would disagree,
 * because a size class cannot know what it has been put on.
 *
 * A size in component markup is therefore a call site deciding roundness on its own, which
 * is what this fails on. Adding a role, or changing what one resolves to, needs no change
 * here — that is the point of them being in one place.
 */

const ROOT = resolve(__dirname, '..');

/**
 * Corner-specific radii are exempt, and deliberately so: `rounded-t-xl` shapes a sheet's
 * top edge only and `rounded-b-frame-inner` tracks the bezel. Those are decisions about one
 * corner of one surface, not about how round a card is.
 *
 * `rounded-xs` is exempt for a narrower reason: the wallpaper picker draws a 6x12px scale
 * model of the phone, and at that size the chip radius clamps to a pill and stops reading as
 * a screen. A miniature is not a box.
 */
const ALLOWED = /^rounded-(?:[tblr]{1,2}-|frame-|box|chip|full|none|xs)/;
const CLASS = /\brounded-[a-z0-9-]+\b/g;

const svelteFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    if (statSync(full).isDirectory()) return svelteFiles(full);
    return full.endsWith('.svelte') ? [full] : [];
  });

describe('the shape scale is reached through a role, never a size', () => {
  const files = [...svelteFiles(join(ROOT, 'sdk')), ...svelteFiles(join(ROOT, 'web/src'))];

  it('finds the components to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('names no raw radius size in component markup', () => {
    const offenders = files.flatMap((file) => {
      const used = readFileSync(file, 'utf8').match(CLASS) ?? [];
      return used
        .filter((cls) => !ALLOWED.test(cls))
        .map((cls) => `${relative(ROOT, file)}: ${cls}`);
    });

    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it('defines both roles against the scale rather than a literal', () => {
    const css = readFileSync(join(ROOT, 'sdk/app.css'), 'utf8');

    expect(css).toMatch(/--radius-box:\s*var\(--radius-[a-z]+\);/);
    expect(css).toMatch(/--radius-chip:\s*var\(--radius-[a-z]+\);/);
  });

  /**
   * The utility layer is hand-written, so a class can be named for one step of the scale and
   * resolve to another. Two were: `.rounded-sm` pointed at `--radius-xs` and `.rounded-xs`
   * at a hard-coded 2px, which is the same "the name does not say what it does" failure as
   * the one above, one layer down.
   */
  it('gives every size utility the token of the same name', () => {
    const css = readFileSync(join(ROOT, 'sdk/app-utilities.css'), 'utf8');
    const mismatched = [...css.matchAll(/\.rounded-([a-z]+)\s*\{\s*border-radius:\s*([^;]+);/g)]
      .filter(([, name]) => ['xs', 'sm', 'md', 'lg', 'xl', 'full'].includes(name))
      .filter(([, name, value]) => value.trim() !== `var(--radius-${name})`)
      .map(([, name, value]) => `.rounded-${name} -> ${value.trim()}`);

    expect(mismatched).toEqual([]);
  });
});
