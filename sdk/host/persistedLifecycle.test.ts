// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. In-process, because a
 * unit test stands in for the shell; the iframe twin has its own file beside it.
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { get, type Writable } from 'svelte/store';
import { render } from '@testing-library/svelte';
import { usePersisted } from './usePersisted';
import { useStorage, clearAppStorage } from './useStorage';
import {
  persistedRehydratorsAll,
  persistedResetsFor,
  registerPersistedHandle,
  registerPersistedRehydrate,
  registerPersistedReset
} from './seam/persistedRegistry';
import UsesPersisted from './__fixtures__/UsesPersisted.svelte';

/**
 * MICA-368. Two things the registry got wrong, both only visible over a session: a store
 * built inside a component left its two callbacks behind on every mount, and every hydrate
 * handed every object store a freshly parsed value whether or not anything had changed.
 */

// A real collection, not a simulated one: the registry's whole claim is about what V8 frees.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/**
 * Collect everything unreachable. A `WeakRef` target is kept alive to the end of the job that
 * created or last dereferenced it, so a macrotask has to pass first — twice, with a GC
 * between, for whatever the first pass only finalized.
 */
async function collect(): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
}

const rehydrateAll = () => {
  for (const rehydrate of persistedRehydratorsAll()) rehydrate();
};
const countRehydrators = () => [...persistedRehydratorsAll()].length;
const countResets = (appId: string) => [...persistedResetsFor(appId)].length;

describe('persisted registry — unregister', () => {
  it('drops a reset, and the app entry with its last one', () => {
    const first = () => {};
    const second = () => {};
    const offFirst = registerPersistedReset('regprobe', first);
    const offSecond = registerPersistedReset('regprobe', second);
    expect(countResets('regprobe')).toBe(2);

    offFirst();
    expect([...persistedResetsFor('regprobe')]).toEqual([second]);

    offSecond();
    offSecond();
    expect(countResets('regprobe')).toBe(0);
  });

  it('drops a rehydrate, and a second call is harmless', () => {
    const before = countRehydrators();
    const off = registerPersistedRehydrate(() => {});
    expect(countRehydrators()).toBe(before + 1);

    off();
    off();
    expect(countRehydrators()).toBe(before);
  });
});

describe('persisted registry — weak handles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('skips a handle whose store is gone, and drops it for good', () => {
    // A `WeakRef` whose target the test decides — the only way to say "collected" on cue.
    let alive = true;
    class SwitchableRef<T extends object> {
      constructor(private readonly target: T) {}
      deref(): T | undefined {
        return alive ? this.target : undefined;
      }
    }
    vi.stubGlobal('WeakRef', SwitchableRef);

    const rehydrate = vi.fn();
    const reset = vi.fn();
    const handle = { appId: 'weakprobe', rehydrate, reset };
    const before = countRehydrators();
    registerPersistedHandle(handle);
    expect(countRehydrators()).toBe(before + 1);
    expect(countResets('weakprobe')).toBe(1);

    alive = false;
    expect(countRehydrators()).toBe(before);
    expect(countResets('weakprobe')).toBe(0);

    // Pruned, not merely skipped: a ref that came back would be walked again otherwise.
    alive = true;
    expect(countRehydrators()).toBe(before);
    rehydrateAll();
    expect(rehydrate).not.toHaveBeenCalled();
  });
});

describe('usePersisted — what keeps a store registered', () => {
  beforeEach(() => clearAppStorage('gcprobe'));

  it('lets a store built inside a component go once the component has', async () => {
    await collect();
    const before = countRehydrators();

    for (let mount = 0; mount < 3; mount++) {
      const { unmount } = render(UsesPersisted, {
        props: { appId: 'gcprobe', settingKey: 'highScore' }
      });
      unmount();
    }
    expect(countRehydrators()).toBe(before + 3);

    await collect();
    expect(countRehydrators()).toBe(before);
  });

  it('keeps a store built during a component init but held at module scope', async () => {
    // The lazy singleton an `onDestroy` unregister would have orphaned: built inside the
    // component, kept outside it, so it must outlive the component and keep rehydrating.
    let kept: Writable<number> | undefined;
    const { unmount } = render(UsesPersisted, {
      props: {
        appId: 'gcprobe',
        settingKey: 'lazy',
        onstore: (store: Writable<number>) => (kept ??= store)
      }
    });
    unmount();
    await collect();

    useStorage('gcprobe').setItem('lazy', 7);
    rehydrateAll();
    expect(get(kept!)).toBe(7);
  });

  it('keeps a store reachable only through its own subscriber', async () => {
    const seen: number[] = [];
    // Nothing holds the store itself — only the writable's subscriber list holds `push`.
    usePersisted('gcprobe', 'subscribedOnly', 0).subscribe((value) => seen.push(value));
    await collect();

    useStorage('gcprobe').setItem('subscribedOnly', 3);
    rehydrateAll();
    expect(seen).toEqual([0, 3]);
  });

  it('lets an unsubscribed store nothing holds go', async () => {
    await collect();
    const before = countRehydrators();
    // In a helper, because the unsubscribe closes over the writable and so over the handle:
    // a test holding `off` across the `await` below would keep the store reachable itself.
    const subscribeOnce = () => usePersisted('gcprobe', 'dropped', 0).subscribe(() => {})();
    subscribeOnce();
    await collect();
    expect(countRehydrators()).toBe(before);
  });
});

describe('usePersisted rehydrate', () => {
  const storage = useStorage('rehydrateprobe');
  beforeEach(() => clearAppStorage('rehydrateprobe'));

  it('leaves an object store alone when its stored string has not changed', () => {
    storage.setItem('prefs', { theme: 'dark' });
    const prefs = usePersisted('rehydrateprobe', 'prefs', { theme: 'light' });
    const seen: unknown[] = [];
    const off = prefs.subscribe((value) => seen.push(value));

    // The hydrate writes the identical string back, as the server's answer would.
    storage.setItem('prefs', { theme: 'dark' });
    rehydrateAll();
    off();

    expect(seen).toHaveLength(1);
  });

  it('takes the new value when the stored string did change', () => {
    storage.setItem('prefs', { theme: 'dark' });
    const prefs = usePersisted('rehydrateprobe', 'prefs', { theme: 'light' });

    storage.setItem('prefs', { theme: 'sepia' });
    rehydrateAll();

    expect(get(prefs)).toEqual({ theme: 'sepia' });
  });

  it("counts the store's own write as already on screen", () => {
    const prefs = usePersisted('rehydrateprobe', 'prefs', { theme: 'light' });
    prefs.set({ theme: 'dark' });
    const seen: unknown[] = [];
    const off = prefs.subscribe((value) => seen.push(value));

    rehydrateAll();
    prefs.update(() => ({ theme: 'sepia' }));
    rehydrateAll();
    off();

    expect(seen).toEqual([{ theme: 'dark' }, { theme: 'sepia' }]);
  });

  it('falls back to the default when the key is removed, and not again after', () => {
    const prefs = usePersisted('rehydrateprobe', 'prefs', { theme: 'light' });
    prefs.set({ theme: 'dark' });
    const seen: unknown[] = [];
    const off = prefs.subscribe((value) => seen.push(value));

    // A character-load sweep: the key goes from storage without the store being told.
    storage.removeItem('prefs');
    rehydrateAll();
    rehydrateAll();
    off();

    expect(seen).toEqual([{ theme: 'dark' }, { theme: 'light' }]);
  });

  it('after a reset, a later write of the old value is still picked up', () => {
    const prefs = usePersisted('rehydrateprobe', 'prefs', { theme: 'light' });
    prefs.set({ theme: 'dark' });

    clearAppStorage('rehydrateprobe');
    expect(get(prefs)).toEqual({ theme: 'light' });

    storage.setItem('prefs', { theme: 'dark' });
    rehydrateAll();
    expect(get(prefs)).toEqual({ theme: 'dark' });
  });
});
