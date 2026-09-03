// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// @ts-expect-error -- a plain .js build module with a hand-written .d.ts beside it.
import { addOnIds, coreValueOf } from '../../web/scripts/addon-ids.js';

/**
 * Which apps are built as add-ons (MICA-190).
 *
 * Discovery reads manifest *text*, because both callers run before anything can evaluate a
 * TypeScript module. It used to test `/core:\s*false/` against the raw file — and a manifest's
 * doc comment is exactly where the word `core` gets discussed.
 *
 * The direction of the failure is the point. In `tools/addon-template` it was loud: the
 * sample manifest's comment explains what `core: true` would mean, and the build refused.
 * Here it is silent and points the other way — the question asked is "does this say
 * `core: false`?", so a **`core: true` app whose comment contains that string answers yes**
 * and is built as an add-on: compiled against `addon.ts`, wrapped by `bootAddOn`, emitted as
 * something the Store can install into a sandboxed iframe. §2.7 and §7 both rest on that
 * classification, since `core: true` is what gates `@gos/sdk/core`, the raw NUI transport.
 */

const ROOT = resolve(__dirname, '../..');

const manifest = (body: string) => `import { defineApp } from '@gos/sdk';\n${body}\n`;

/** A throwaway apps directory holding exactly the manifests a case needs. */
const appsDirWith = (apps: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gos-addon-ids-'));
  for (const [id, source] of Object.entries(apps)) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'manifest.ts'), source);
  }
  return dir;
};

describe('add-on discovery reads the declaration, not the prose', () => {
  it('does not discover a core app whose comment mentions core: false', () => {
    const dir = appsDirWith({
      settings: manifest(`/**
 * The phone's own settings. Ships with the phone.
 *
 * This is not an add-on: an add-on would say core: false here and be installed from the
 * Store instead.
 */
export default defineApp({ id: 'settings', core: true });`)
    });

    try {
      // Before this fix the comment answered for the property, and Settings — which gates
      // \`@gos/sdk/core\` on being core — would have been built as an installable add-on.
      expect(addOnIds(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still discovers an add-on whose comment mentions core: true', () => {
    const dir = appsDirWith({
      notes: manifest(`/**
 * Notes. A Store add-on, so core: true would be wrong here.
 */
export default defineApp({ id: 'notes', core: false });`)
    });

    try {
      expect(addOnIds(dir)).toEqual(['notes']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Neither value is not "not an add-on". An omitted `core` is a manifest `defineApp` rejects
   * outright, and a value discovery cannot read is one it must not classify by guessing.
   */
  it('reads a missing declaration as unknown rather than as core', () => {
    expect(coreValueOf(manifest(`export default defineApp({ id: 'x' });`))).toBeNull();
    expect(coreValueOf(manifest(`export default defineApp({ id: 'x', core: true });`))).toBe(true);
    expect(coreValueOf(manifest(`export default defineApp({ id: 'x', core: false });`))).toBe(
      false
    );
  });

  it('is not fooled by a line comment either', () => {
    expect(coreValueOf(`// core: false\nexport default defineApp({ id: 'x', core: true });`)).toBe(
      true
    );
  });

  /**
   * The real tree, so this cannot pass on fixtures while the shipped set has changed. Four
   * add-ons today; `pnpm build` emits exactly these bundles.
   */
  it('finds the four add-ons this repo actually ships', () => {
    expect(addOnIds(join(ROOT, 'web/src/apps')).sort()).toEqual([
      'blabber',
      'hodlr',
      'notes',
      'snek'
    ]);
  });

  /**
   * Both callers go through the one module now. The comment that used to sit in
   * `vite.addon.config.ts` said the dedupe had been tried and abandoned over `TS7016`, and
   * that the fix if the copies drifted was proper JS module type support rather than a
   * hardcoded list — `addon-ids.d.ts` is that fix, so a second copy should not reappear.
   */
  it.each(['web/vite.addon.config.ts', 'web/scripts/build-addons.mjs'])(
    '%s imports the shared discovery rather than grepping raw text',
    (file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');

      expect(source).toContain('addon-ids.js');
      expect(source).not.toMatch(/\/core:\\s\*false\//);
    }
  );
});
