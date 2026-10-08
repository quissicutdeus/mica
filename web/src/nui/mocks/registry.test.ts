// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { mockRegistry } from './registry';

/**
 * The one-file-per-service split (MICA-323) is collected by glob, so the failure to guard
 * against is a file the glob quietly stops seeing: a renamed export, a moved directory, a
 * pattern that no longer matches. Every one of those shrinks the registry without an error,
 * and a mock that silently vanishes is the dead-in-`pnpm dev` failure §8 describes.
 */
describe('the mock registry', () => {
  const sources = import.meta.glob<string>(['./services/*.ts', '!./services/*.test.ts'], {
    eager: true,
    query: '?raw',
    import: 'default'
  });
  const modules = import.meta.glob<Record<string, unknown>>(
    ['./services/*.ts', '!./services/*.test.ts'],
    { eager: true }
  );

  /**
   * A ratchet, not a census. The split landed with 159 keys, every one of them the same key
   * the single 2,868-line file answered and every handler's body unchanged — proved once,
   * against that file, when the split landed. Adding a mock needs no edit here; losing a
   * file's worth of them fails. Raise the floor when a service is added, never lower it to
   * make a removal pass without saying why in the commit.
   */
  it('answers at least as many keys as when it was split', () => {
    expect(Object.keys(mockRegistry).length).toBeGreaterThanOrEqual(159);
  });

  it('collects every service file, and every one of them answers something', () => {
    expect(Object.keys(modules).length).toBeGreaterThan(0);
    for (const [file, mod] of Object.entries(modules)) {
      expect(mod.mocks, `${file} must export \`mocks\``).toBeTypeOf('object');
      const keys = Object.keys(mod.mocks as object);
      expect(keys.length, `${file} answers nothing`).toBeGreaterThan(0);
      for (const key of keys) expect(mockRegistry[key], `${file}: ${key}`).toBeTypeOf('function');
    }
  });

  /**
   * `server/__tests__/routes.test.ts` reads these files as text — the root Vitest project
   * has no `import.meta.glob` — and finds each file's keys by this exact declaration on a
   * line of its own. A file that spelled it differently would still load here and be
   * invisible there, which is the half that cross-checks every key against the server.
   */
  it('declares `mocks` in the shape the server-side cross-check reads', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).toMatch(/^export const mocks\b[^\n]*=\s*\{$/m);
      expect(text.match(/^export const mocks\b/gm), file).toHaveLength(1);
    }
  });
});
