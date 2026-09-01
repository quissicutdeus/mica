// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. In-process, because a
 * unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn().mockResolvedValue([]),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

/**
 * A chunk that is gone, which is what a deploy under an open page leaves behind.
 *
 * Mocked in its own file rather than added to `registry.test.ts`: the module-level "already
 * prompted" latch means each case needs a fresh copy of the registry, and `vi.resetModules`
 * in the middle of that suite would reset far more than this.
 */
vi.mock('../../apps/calculator/index.svelte', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

/**
 * A second one, because one app failing twice proves nothing about the latch: `loading` in
 * `registry.ts` memoises the rejected promise, so a repeat call never reaches the catch.
 */
vi.mock('../../apps/places/index.svelte', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

/**
 * A fresh registry each time, since the prompt fires once per module instance.
 *
 * `resetModules` clears the facet registration along with everything else, so the reset
 * copy re-registers before anything reaches for `persisted` — the same first-import rule
 * the top of this file follows, applied to the second graph.
 */
const freshRegistry = async () => {
  vi.resetModules();
  await import('../../host/registerFacets');
  const [{ appRegistryStore }, { toast }] = await Promise.all([
    import('./registry'),
    import('./toast')
  ]);
  return { appRegistryStore, toast };
};

describe('a chunk that will not load offers a reload', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (window as unknown as { invokeNative?: unknown }).invokeNative;
    vi.restoreAllMocks();
  });

  it('prompts with a Reload action when the import fails in a browser', async () => {
    const { appRegistryStore, toast } = await freshRegistry();

    await appRegistryStore.loadComponent('calculator');

    const [shown] = get(toast);
    expect(shown).toBeDefined();
    expect(shown.actions?.map((a) => a.label)).toEqual(['Reload']);
    // Sticky: it asks for a decision, and one that expires is one the player has to
    // reproduce the fault to see again.
    expect(shown.duration).toBe(0);
  });

  /**
   * The gate that keeps `window.location` out of CEF (AGENTS.md §6), where a reload drops
   * every bit of state the phone is holding. In game the situation cannot arise anyway — the
   * NUI page is rebuilt whenever the resource restarts — so the prompt would be an offer to
   * make things worse for no reason.
   */
  it('stays silent in CEF, where a reload is the more expensive failure', async () => {
    (window as unknown as { invokeNative?: unknown }).invokeNative = () => {};
    const { appRegistryStore, toast } = await freshRegistry();

    await appRegistryStore.loadComponent('calculator');

    expect(get(toast)).toHaveLength(0);
  });

  it('prompts once however many apps fail, since it is one deploy to recover from', async () => {
    const { appRegistryStore, toast } = await freshRegistry();

    await appRegistryStore.loadComponent('calculator');
    expect(get(toast)).toHaveLength(1);

    toast.clear();
    await appRegistryStore.loadComponent('places');

    expect(get(toast)).toHaveLength(0);
  });
});
