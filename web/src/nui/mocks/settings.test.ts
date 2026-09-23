// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-287 round 4: `settingsFromLocalStorage` (`./registry.ts`) reads `localStorage`
 * directly, which this project's jsdom does not actually provide — see
 * `IframeHostServer.test.ts`'s own note on the same fact — so every test here stubs a
 * minimal `Storage`-shaped global rather than relying on jsdom's. `vi.resetModules()`
 * before each case is what `ownerConfig.test.ts` does too: `mockSettings` is module scope,
 * and a write from one test must not answer the next.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Built, not quoted: a bare `mica:` string literal reads as a net event name to
 * `server/__tests__/eventNames.test.ts`, which scans `web/src` too. */
const storageKey = (app: string, key: string) => `mica:${app}:${key}`;

/**
 * A `Storage`-shaped stub that is its own backing store — `registry.ts` walks
 * `Object.keys(localStorage)` to find `mica:*` entries, and a stub whose data lives in a
 * separate closure never shows up there, only through `getItem`. Mirrors
 * `IframeHostServer.test.ts`'s `stubLocalStorage`.
 */
function stubLocalStorage(seed: Record<string, string> = {}): Record<string, string> {
  const stub: Record<string, unknown> = {
    getItem: (key: string) => (stub[key] as string) ?? null,
    setItem: (key: string, value: string) => {
      stub[key] = value;
    },
    removeItem: (key: string) => {
      delete stub[key];
    }
  };
  Object.assign(stub, seed);
  vi.stubGlobal('localStorage', stub);
  return stub as Record<string, string>;
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('the settings:getAll mock (MICA-287 round 4)', () => {
  /**
   * A browser has no server, so an e2e that seeds `localStorage` before boot (rather than
   * driving a real `settings:set` round trip) is standing in for "the server already has
   * this row" — exactly `web/e2e/support/homeGrid.ts`'s `seedHomeGrid`. Before this fix
   * `settings:getAll` answered from `mockSettings` alone, which starts empty on every
   * load: the character-load sweep in `host/facets/storage.ts` read that as "this
   * character has nothing" and deleted the seeded key straight back out
   * (`fresh-character.spec.ts`).
   */
  it('answers from localStorage — a seeded key survives a getAll it was never written through', async () => {
    stubLocalStorage({
      [storageKey('settings', 'homeGridItems')]: '[{"position":0,"kind":"app","appId":"bank"}]'
    });
    const { MockRegistry } = await import('./registry');

    const rows = (await MockRegistry.handle('settings:getAll')) as Array<{
      app: string;
      setting_key: string;
      setting_value: string;
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        app: 'settings',
        setting_key: 'homeGridItems',
        setting_value: '[{"position":0,"kind":"app","appId":"bank"}]'
      })
    ]);
  });

  it('ignores a device key outside the mica:<app>:<key> shape', async () => {
    stubLocalStorage({
      mica_first_boot_time: '12345',
      mica_unsynced_settings: '["blabber:wallpaper"]',
      mica_installed_remote_apps: '[]'
    });
    const { MockRegistry } = await import('./registry');

    expect(await MockRegistry.handle('settings:getAll')).toEqual([]);
  });

  it('merges a write made through settings:set with what localStorage already holds', async () => {
    stubLocalStorage({ [storageKey('settings', 'theme')]: '"dark"' });
    const { MockRegistry } = await import('./registry');

    await MockRegistry.handle('settings:set', { app: 'settings', key: 'volume', value: '5' });

    const rows = (await MockRegistry.handle('settings:getAll')) as Array<{
      setting_key: string;
      setting_value: string;
    }>;
    expect(rows.map((r) => r.setting_key).sort()).toEqual(['theme', 'volume']);
    expect(rows.find((r) => r.setting_key === 'volume')?.setting_value).toBe('5');
  });

  it('drops a key once settings:remove clears it, even though localStorage still seeded it at boot', async () => {
    const store = stubLocalStorage({ [storageKey('settings', 'theme')]: '"dark"' });
    const { MockRegistry } = await import('./registry');

    // Mirrors the real flow: `useStorage.removeItem` clears `localStorage` itself before
    // `settingsSync.ts` ever calls the server (or, here, the mock).
    delete store[storageKey('settings', 'theme')];
    await MockRegistry.handle('settings:remove', { app: 'settings', key: 'theme' });

    expect(await MockRegistry.handle('settings:getAll')).toEqual([]);
  });
});
