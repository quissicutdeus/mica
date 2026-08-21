import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppComponent } from '@gphone/sdk';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn().mockResolvedValue([]),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

import { appRegistryStore, getFirstBootTime, type AppManifest } from './registry';
import { hydrateSettings, useStorage } from '../../sdk/host/useStorage';
import { setTrustedRemoteAppHosts, sha256Hex } from './remoteAppSecurity';

describe('App Registry Store', () => {
  it('does not warn when installing a bundled add-on, but warns when replacing an already installed app', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const blabberComponent = appRegistryStore.getComponent('blabber') as AppComponent;
      expect(get(appRegistryStore).some((a) => a.id === 'blabber')).toBe(false);

      // Clean bundled add-on install should log no warning
      appRegistryStore.registerApp(
        { id: 'blabber', name: 'Blabber', color: 'bg-sky-500', icon: null, core: false },
        blabberComponent
      );
      expect(warnSpy).not.toHaveBeenCalled();

      // Registering over an already installed app should trigger warning
      appRegistryStore.registerApp(
        {
          id: 'blabber',
          name: 'Blabber Reinstalled',
          color: 'bg-sky-500',
          icon: null,
          core: false
        },
        blabberComponent
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('is already registered and is being replaced');
    } finally {
      warnSpy.mockRestore();
      appRegistryStore.unregisterApp('blabber');
    }
  });

  it('loads built-in manifests on startup with first boot timestamps', () => {
    const apps = get(appRegistryStore);
    expect(apps.length).toBeGreaterThan(0);
    const firstBoot = getFirstBootTime();
    expect(firstBoot).toBeDefined();
    expect(apps[0].installedAt).toBe(firstBoot);
    expect(apps[0].updatedAt).toBe(firstBoot);
  });

  it('provides a persistent read-only first boot timestamp', () => {
    const time1 = getFirstBootTime();
    const time2 = getFirstBootTime();
    expect(time1).toBe(time2);
  });

  it('allows dynamic registration of custom third-party apps with installation timestamps', () => {
    const mockManifest: AppManifest = {
      id: 'crypto_app',
      name: 'Crypto',
      color: '#f59e0b',
      icon: null,
      core: false
    };
    // Registry bookkeeping only — nothing here renders, so a stub stands in for the
    // component the registry now insists on having.
    const mockComponent = {} as unknown as AppComponent;

    appRegistryStore.registerApp(mockManifest, mockComponent);

    const apps = get(appRegistryStore);
    const registered = apps.find((a) => a.id === 'crypto_app');

    expect(registered).toBeDefined();
    expect(registered?.name).toBe('Crypto');
    expect(registered?.installedAt).toBeDefined();
    expect(registered?.updatedAt).toBeDefined();
    expect(appRegistryStore.getComponent('crypto_app')).toBe(mockComponent);

    // Re-registering preserves installedAt while updating updatedAt
    const initialInstalledAt = registered?.installedAt;
    const updatedManifest: AppManifest = {
      ...mockManifest,
      name: 'Crypto Pro'
    };
    appRegistryStore.registerApp(updatedManifest, mockComponent);
    const reRegistered = get(appRegistryStore).find((a) => a.id === 'crypto_app');
    expect(reRegistered?.name).toBe('Crypto Pro');
    expect(reRegistered?.installedAt).toBe(initialInstalledAt);
  });

  /**
   * A bundled add-on survives being uninstalled and installed again.
   *
   * This is the defect the split between `bundledComponents` and `componentRegistry` exists for.
   * One map meant `unregisterApp` deleted the only reference to code still sitting in the bundle,
   * so the Store's `getComponent(id) || placeholderComponent()` handed the registry the "Not part
   * of this build" screen on reinstall — for an app whose code had never left. In CEF the page
   * never unloads, so it stayed broken for the rest of the session.
   */
  it('keeps a bundled add-on mountable across uninstall and reinstall', async () => {
    const blabber = get(appRegistryStore).find((a) => a.id === 'blabber');
    // Blabber ships `core: false`, so it starts uninstalled and the glob is the only thing that
    // has ever supplied its component.
    expect(blabber).toBeUndefined();

    // Components load on demand now, so the glob supplies a *loader* and nothing resolves
    // until an app is first opened. `getComponent` answers from the cache, which is empty
    // here; `loadComponent` is what fills it.
    expect(appRegistryStore.getComponent('blabber')).toBeUndefined();
    expect(appRegistryStore.isKnownApp('blabber')).toBe(true);

    const bundled = await appRegistryStore.loadComponent('blabber');
    expect(bundled).toBeDefined();

    // Install, exactly as the Store does.
    appRegistryStore.registerApp(
      { id: 'blabber', name: 'Blabber', color: 'bg-sky-500', icon: null, core: false },
      appRegistryStore.getComponent('blabber') as AppComponent
    );
    expect(get(appRegistryStore).some((a) => a.id === 'blabber')).toBe(true);

    appRegistryStore.unregisterApp('blabber');
    expect(get(appRegistryStore).some((a) => a.id === 'blabber')).toBe(false);

    // The component is still there, because the code is still in the build.
    expect(appRegistryStore.getComponent('blabber')).toBe(bundled);
  });

  it('forgets a remote app’s component on uninstall, because that code really is gone', async () => {
    const code = `
      export const manifest = { id: 'remote_gone', name: 'Gone', color: 'bg-gray-600', icon: null };
      export const component = { type: 'MockRemoteComponent' };
    `;
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

    await appRegistryStore.loadRemoteApp(url);
    expect(appRegistryStore.getComponent('remote_gone')).toBeDefined();

    appRegistryStore.unregisterApp('remote_gone');

    // No bundle to fall back to — the asymmetry with a bundled add-on is the whole point.
    expect(appRegistryStore.getComponent('remote_gone')).toBeUndefined();
  });

  it('prohibits unregistering built-in core apps', () => {
    expect(() => appRegistryStore.unregisterApp('contacts')).toThrow(
      "gPhone App Registry error: Unregistering core app 'contacts' is prohibited."
    );
  });

  it('allows dynamic loading of remote ES module bundles via data URLs', async () => {
    const mockAppCode = `
      export const manifest = {
        id: 'remote_marketplace',
        name: 'Marketplace',
        color: 'bg-emerald-600',
        icon: 'https://example.com/icon.svg',
      };
      export const component = { type: 'MockRemoteComponent' };
    `;
    const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(mockAppCode)}`;

    const result = await appRegistryStore.loadRemoteApp(dataUrl);

    expect(result.manifest.id).toBe('remote_marketplace');
    expect(result.manifest.isRemote).toBe(true);
    expect(result.manifest.bundleUrl).toBe(dataUrl);

    const apps = get(appRegistryStore);
    const installed = apps.find((a) => a.id === 'remote_marketplace');
    expect(installed).toBeDefined();
    expect(appRegistryStore.getComponent('remote_marketplace')).toBeDefined();

    // Clean up dynamic app
    appRegistryStore.unregisterApp('remote_marketplace');
  });

  it('rejects loading remote apps with invalid URLs or missing manifests', async () => {
    await expect(appRegistryStore.loadRemoteApp('')).rejects.toThrow(
      'gPhone App Loader error: Remote app URL must be a valid string.'
    );
  });

  it('rejects a remote app host that is not on the allowlist', async () => {
    setTrustedRemoteAppHosts([]);
    await expect(
      appRegistryStore.loadRemoteApp('https://not-trusted.example.com/app.js')
    ).rejects.toThrow(
      "'https://not-trusted.example.com/app.js' is not on the trusted remote-app host allowlist"
    );
  });
});

describe('installFromCatalog', () => {
  const bundleCode = `
      export const manifest = {
        id: 'remote_catalog_app',
        name: 'Catalog App',
        color: 'bg-emerald-600',
        icon: null,
      };
      export const component = { type: 'MockRemoteComponent' };
    `;
  // sha256 of `bundleCode` above, byte-for-byte — do not reformat the template literal
  // without recomputing this.
  const bundleSha256 = '4f86f544a3b1aac2670fed9693990f135ebf9a134305917ccd0bbd0e805048fe';
  const bundleUrl = 'https://store.example.com/apps/catalog_app.js';

  const catalogEntry = {
    id: 'remote_catalog_app',
    name: 'Catalog App',
    version: '1.0.0',
    description: 'A catalog-installed app.',
    bundleUrl,
    sha256: bundleSha256,
    color: 'bg-emerald-600'
  };

  const fetchResponse = (text: string, ok = true, status = 200): Response =>
    ({ ok, status, text: () => Promise.resolve(text) }) as Response;

  beforeEach(() => {
    setTrustedRemoteAppHosts(['store.example.com']);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (appRegistryStore.getComponent('remote_catalog_app')) {
      appRegistryStore.unregisterApp('remote_catalog_app');
    }
  });

  it('installs a bundle whose hash matches the catalog entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode));

    const result = await appRegistryStore.installFromCatalog(catalogEntry);

    expect(result.manifest.id).toBe('remote_catalog_app');
    expect(result.manifest.isRemote).toBe(true);
    expect(result.manifest.bundleUrl).toBe(bundleUrl);
    expect(appRegistryStore.getComponent('remote_catalog_app')).toBeDefined();
  });

  it('refuses to import a bundle whose hash does not match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode + '// tampered'));

    await expect(appRegistryStore.installFromCatalog(catalogEntry)).rejects.toThrow(
      'did not match its published checksum'
    );
    expect(appRegistryStore.getComponent('remote_catalog_app')).toBeUndefined();
  });

  it('refuses a bundleUrl that is not on the trusted host allowlist', async () => {
    setTrustedRemoteAppHosts(['a-different-host.example.com']);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(appRegistryStore.installFromCatalog(catalogEntry)).rejects.toThrow(
      'is not on the trusted remote-app host allowlist'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses on a non-ok HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse('', false, 404));

    await expect(appRegistryStore.installFromCatalog(catalogEntry)).rejects.toThrow('HTTP 404');
  });
});

describe('remote app persistence and rehydration', () => {
  /**
   * This jsdom test environment has no real `localStorage` (see `storage.test.ts`'s note on
   * the same fact) — `typeof localStorage`/`window.localStorage` are both `undefined` here,
   * even though the shell's actual runtime (browser/CEF) always has one. `registry.ts`'s
   * persistence functions read the bare `localStorage` global directly (not through
   * `useStorage`'s in-memory fallback), so these tests — which assert on what actually landed
   * in storage, and on rehydration reading it back — need a real-shaped one to exist. A
   * minimal in-memory polyfill, installed only around this describe block's tests and removed
   * after, is the least-invasive way to give them that without changing the shared jsdom
   * environment for every other test file.
   */
  let localStorageBacking: Map<string, string>;

  const bundleCode = `
      export const manifest = {
        id: 'remote_rehydrate_app',
        name: 'Rehydrate App',
        color: 'bg-purple-600',
        icon: null,
      };
      export const component = { type: 'MockRemoteComponent' };
    `;
  // sha256 of `bundleCode` above, byte-for-byte — do not reformat the template literal
  // without recomputing this.
  const bundleSha256 = '984cedc40b8f071ffca1e5cc648a75a8de167d148666991bc428bb953ffdebdc';
  const bundleUrl = 'https://store.example.com/apps/rehydrate_app.js';

  const fetchResponse = (text: string, ok = true, status = 200): Response =>
    ({ ok, status, text: () => Promise.resolve(text) }) as Response;

  beforeEach(() => {
    setTrustedRemoteAppHosts(['store.example.com']);
    vi.restoreAllMocks();
    localStorageBacking = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => localStorageBacking.get(key) ?? null,
      setItem: (key: string, value: string) => localStorageBacking.set(key, String(value)),
      removeItem: (key: string) => localStorageBacking.delete(key)
    };
  });

  afterEach(() => {
    if (appRegistryStore.getComponent('remote_rehydrate_app')) {
      appRegistryStore.unregisterApp('remote_rehydrate_app');
    }
    delete (globalThis as any).localStorage;
  });

  it('persists the pinned sha256 for a catalog install, not just the URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode));

    await appRegistryStore.installFromCatalog({
      id: 'remote_rehydrate_app',
      name: 'Rehydrate App',
      version: '1.0.0',
      description: 'desc',
      bundleUrl,
      sha256: bundleSha256,
      color: 'bg-purple-600'
    });

    const stored = JSON.parse(localStorage.getItem('gphone_installed_remote_apps') ?? '[]');
    expect(stored).toEqual([{ url: bundleUrl, sha256: bundleSha256 }]);
  });

  it('re-verifies a hash-pinned install on rehydration and refuses a tampered bundle', async () => {
    // Storage holds the hash pinned at install time; the server now serves something else —
    // exactly what "swapped out after install" looks like.
    localStorage.setItem(
      'gphone_installed_remote_apps',
      JSON.stringify([{ url: bundleUrl, sha256: bundleSha256 }])
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode + '// tampered'));

    await appRegistryStore.rehydrateSavedRemoteApps();

    expect(appRegistryStore.getComponent('remote_rehydrate_app')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`re-hydrate remote app from '${bundleUrl}'`),
      expect.any(Error)
    );
  });

  it('rehydrates a hash-pinned install whose bundle still matches', async () => {
    localStorage.setItem(
      'gphone_installed_remote_apps',
      JSON.stringify([{ url: bundleUrl, sha256: bundleSha256 }])
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode));

    await appRegistryStore.rehydrateSavedRemoteApps();

    expect(appRegistryStore.getComponent('remote_rehydrate_app')).toBeDefined();
  });

  it('upgrades a hash-less loadRemoteApp record to a pinned hash on a later catalog install', async () => {
    // `loadRemoteApp`'s direct-import attempt on a real https URL fails in this test
    // environment (no such module to import), so it falls back to `fetch` — which is
    // mocked below — exactly like the CEF fallback path it is meant to cover.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode));

    await appRegistryStore.loadRemoteApp(bundleUrl);
    expect(JSON.parse(localStorage.getItem('gphone_installed_remote_apps') ?? '[]')).toEqual([
      { url: bundleUrl }
    ]);

    await appRegistryStore.installFromCatalog({
      id: 'remote_rehydrate_app',
      name: 'Rehydrate App',
      version: '1.0.0',
      description: 'desc',
      bundleUrl,
      sha256: bundleSha256,
      color: 'bg-purple-600'
    });

    const stored = JSON.parse(localStorage.getItem('gphone_installed_remote_apps') ?? '[]');
    expect(stored).toEqual([{ url: bundleUrl, sha256: bundleSha256 }]);
  });

  it('replaces a stale pinned hash when the same bundleUrl is reinstalled with a new one', async () => {
    const updatedCode = bundleCode.replace('Rehydrate App', 'Rehydrate App v2');
    const updatedSha256 = await sha256Hex(updatedCode);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(fetchResponse(bundleCode));

    await appRegistryStore.installFromCatalog({
      id: 'remote_rehydrate_app',
      name: 'Rehydrate App',
      version: '1.0.0',
      description: 'desc',
      bundleUrl,
      sha256: bundleSha256,
      color: 'bg-purple-600'
    });

    fetchSpy.mockResolvedValueOnce(fetchResponse(updatedCode));

    await appRegistryStore.installFromCatalog({
      id: 'remote_rehydrate_app',
      name: 'Rehydrate App v2',
      version: '1.0.1',
      description: 'desc',
      bundleUrl,
      sha256: updatedSha256,
      color: 'bg-purple-600'
    });

    const stored = JSON.parse(localStorage.getItem('gphone_installed_remote_apps') ?? '[]');
    expect(stored).toEqual([{ url: bundleUrl, sha256: updatedSha256 }]);
  });

  it('still rehydrates a pre-existing plain-string-array install from before this change', async () => {
    const legacyUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(bundleCode)}`;
    localStorage.setItem('gphone_installed_remote_apps', JSON.stringify([legacyUrl]));

    await appRegistryStore.rehydrateSavedRemoteApps();

    // No `sha256` in the old shape, so this goes through `loadRemoteApp`, unverified —
    // exactly the behavior this install had before this task shipped.
    expect(appRegistryStore.getComponent('remote_rehydrate_app')).toBeDefined();
  });
});

describe('installed add-on persistence', () => {
  it('persists a bundled add-on install and removes it on uninstall', async () => {
    const blabberComponent = (await appRegistryStore.loadComponent('blabber')) as AppComponent;

    appRegistryStore.registerApp(
      { id: 'blabber', name: 'Blabber', color: 'bg-sky-500', icon: null, core: false },
      blabberComponent
    );
    expect(useStorage('store').getItem<string[]>('installedAddOns')).toEqual(['blabber']);

    appRegistryStore.unregisterApp('blabber');
    expect(useStorage('store').getItem<string[]>('installedAddOns')).toEqual([]);
  });

  it('does not track a remote app in the installed add-on list', async () => {
    const code = `
      export const manifest = { id: 'remote_installed_addons_test', name: 'Remote', color: 'bg-gray-600', icon: null };
      export const component = { type: 'MockRemoteComponent' };
    `;
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

    await appRegistryStore.loadRemoteApp(url);
    expect(useStorage('store').getItem<string[]>('installedAddOns')).toEqual([]);

    appRegistryStore.unregisterApp('remote_installed_addons_test');
  });

  it('re-registers a previously installed bundled add-on when the server row arrives', async () => {
    expect(get(appRegistryStore).some((a) => a.id === 'blabber')).toBe(false);

    serviceMock.fetchSettings.mockResolvedValueOnce([
      { app: 'store', setting_key: 'installedAddOns', setting_value: '["blabber"]' }
    ]);

    await hydrateSettings();
    await vi.waitFor(() => {
      expect(get(appRegistryStore).some((a) => a.id === 'blabber')).toBe(true);
    });

    appRegistryStore.unregisterApp('blabber');
  });
});
