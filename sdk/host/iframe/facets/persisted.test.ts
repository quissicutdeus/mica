// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MICA-368, the iframe twin: an add-on's `usePersisted` rehydrates from the snapshot the
 * shell pushes after every character load, and must skip a key whose string did not change
 * exactly as the in-process store does (`sdk/host/persistedLifecycle.test.ts`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { fakeTransport } from '../__fixtures__/fakeTransport';
import { hydrateStorage } from '../storageCache';
import { persistedRehydratorsAll } from '../../seam/persistedRegistry';
import { persisted } from './persisted';

const storageKey = (appId: string, key: string) => `mica:${appId}:${key}`;
const rehydrateAll = () => {
  for (const rehydrate of persistedRehydratorsAll()) rehydrate();
};

beforeEach(() => {
  fakeTransport();
  hydrateStorage({});
});

describe('iframe persisted — rehydrate', () => {
  it('leaves an object store alone when the pushed string is the one already read', () => {
    hydrateStorage({ [storageKey('addon', 'prefs')]: '{"theme":"dark"}' });
    const prefs = persisted('addon', 'prefs', { theme: 'light' });
    const seen: unknown[] = [];
    const off = prefs.subscribe((value) => seen.push(value));

    hydrateStorage({ [storageKey('addon', 'prefs')]: '{"theme":"dark"}' });
    rehydrateAll();
    off();

    expect(seen).toHaveLength(1);
  });

  it('takes a changed string, and treats its own write as already on screen', () => {
    const prefs = persisted('addon', 'prefs', { theme: 'light' });
    prefs.set({ theme: 'dark' });
    const seen: unknown[] = [];
    const off = prefs.subscribe((value) => seen.push(value));

    rehydrateAll();
    hydrateStorage({ [storageKey('addon', 'prefs')]: '{"theme":"sepia"}' });
    rehydrateAll();
    off();

    expect(seen).toEqual([{ theme: 'dark' }, { theme: 'sepia' }]);
    expect(get(prefs)).toEqual({ theme: 'sepia' });
  });
});
