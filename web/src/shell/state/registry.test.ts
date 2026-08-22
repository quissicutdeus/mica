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
import type { CatalogEntry } from './catalog';

const fetchResponse = (text: string, ok = true, status = 200): Response =>
  ({ ok, status, statusText: '', text: () => Promise.resolve(text) }) as Response;

describe('App Registry Store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

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
   * `registerApp` with a `core: false` manifest is dev-only — `error_boundary.spec.ts`'s
   * runtime crash fixtures are the intended (and only) non-core caller, and e2e runs
   * against `pnpm dev`, where `import.meta.env.DEV` is `true`. Every other test in this
   * file registers non-core manifests through `registerApp` too, relying on vitest also
   * having `DEV` true — this is the one place that pins the gate itself, on both sides.
   */
  it('blocks registerApp for a non-core manifest outside DEV, and allows it in DEV', () => {
    const manifest: AppManifest = {
      id: 'dev_gate_fixture',
      name: 'Dev Gate Fixture',
      color: 'bg-red-500',
      icon: null,
      core: false
    };
    const component = {} as unknown as AppComponent;

    vi.stubEnv('DEV', false);
    try {
      expect(() => appRegistryStore.registerApp(manifest, component)).toThrow(
        'add-ons register through registerAddOn(manifest, source)'
      );
      expect(get(appRegistryStore).some((a) => a.id === 'dev_gate_fixture')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }

    appRegistryStore.registerApp(manifest, component);
    expect(get(appRegistryStore).some((a) => a.id === 'dev_gate_fixture')).toBe(true);
    appRegistryStore.unregisterApp('dev_gate_fixture');
  });

  it('does not export loadRemoteApp any more — it executed fetched code to learn a manifest', () => {
    expect((appRegistryStore as any).loadRemoteApp).toBeUndefined();
  });

  /**
   * `registerAddOn` is the whole point of this task: an add-on's bundle is source text,
   * never a component, and the registry never `import()`s it.
   */
  it('registers an add-on as source text, never a component', async () => {
    const manifest: AppManifest = {
      id: 'ad_hoc_addon',
      name: 'Ad Hoc',
      color: 'bg-teal-500',
      icon: null,
      core: false
    };
    try {
      appRegistryStore.registerAddOn(manifest, 'export {}');

      expect(appRegistryStore.isKnownApp('ad_hoc_addon')).toBe(true);
      await expect(appRegistryStore.getAddOnSource('ad_hoc_addon')).resolves.toBe('export {}');
      expect(appRegistryStore.getComponent('ad_hoc_addon')).toBeUndefined();
    } finally {
      appRegistryStore.unregisterApp('ad_hoc_addon');
    }
  });

  it('refuses registerAddOn with no source for an id that is not a bundled add-on', () => {
    expect(() =>
      appRegistryStore.registerAddOn({
        id: 'not_a_bundled_addon',
        name: 'Nope',
        color: 'bg-red-500',
        icon: null,
        core: false
      })
    ).toThrow('there is nothing for getAddOnSource to fetch');
  });

  /**
   * A bundled add-on's source arrives lazily, on first open, and only once — a second
   * `getAddOnSource` (or two in-flight at the same time) must not trigger a second fetch.
   */
  it("fetches a bundled add-on's source once, even when asked for twice at once", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse('export {}'));

    try {
      const [first, second] = await Promise.all([
        appRegistryStore.getAddOnSource('notes'),
        appRegistryStore.getAddOnSource('notes')
      ]);

      expect(first).toBe('export {}');
      expect(second).toBe('export {}');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith('./addons/notes.js');
    } finally {
      appRegistryStore.unregisterApp('notes');
    }
  });

  /**
   * This is the defect the split between `bundledComponents`/`addOnIds` and the runtime
   * maps exists for, restated for source text: a bundled add-on is known to
   * `isKnownApp` — and its source fetchable — whether or not it has ever been installed,
   * because the glob is a fact about the build, not the install.
   */
  it("keeps a bundled add-on's source fetchable across uninstall and reinstall, refetching after uninstall", async () => {
    const blabber = get(appRegistryStore).find((a) => a.id === 'blabber');
    expect(blabber).toBeUndefined();
    expect(appRegistryStore.getComponent('blabber')).toBeUndefined();
    expect(appRegistryStore.isKnownApp('blabber')).toBe(true);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fetchResponse('export {} // blabber'));

    const source = await appRegistryStore.getAddOnSource('blabber');
    expect(source).toBe('export {} // blabber');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Install, exactly as the Store does now — no component.
    appRegistryStore.registerAddOn({
      id: 'blabber',
      name: 'Blabber',
      color: 'bg-sky-500',
      icon: null,
      core: false
    });
    expect(get(appRegistryStore).some((a) => a.id === 'blabber')).toBe(true);

    appRegistryStore.unregisterApp('blabber');
    expect(get(appRegistryStore).some((a) => a.id === 'blabber')).toBe(false);

    // The fetched text was dropped on uninstall, so the next ask fetches again.
    const sourceAgain = await appRegistryStore.getAddOnSource('blabber');
    expect(sourceAgain).toBe('export {} // blabber');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("forgets a remote app's source on uninstall — unlike a bundled add-on, there is no bundle to refetch", async () => {
    const source = 'export const manifest = { id: "remote_gone" };';
    const manifest: AppManifest = {
      id: 'remote_gone',
      name: 'Gone',
      color: 'bg-gray-600',
      icon: null,
      core: false,
      isRemote: true
    };

    appRegistryStore.registerAddOn(manifest, source);
    expect(await appRegistryStore.getAddOnSource('remote_gone')).toBe(source);

    appRegistryStore.unregisterApp('remote_gone');

    expect(await appRegistryStore.getAddOnSource('remote_gone')).toBeUndefined();
  });

  it('resolves a bundled add-on manifest that has never been installed', () => {
    // A `?app=notes` deep link opens an uninstalled add-on by design, and `Shell.svelte`
    // will not render it without a manifest — an installed-only lookup left that on a
    // permanent spinner.
    expect(get(appRegistryStore).some((a) => a.id === 'notes')).toBe(false);
    expect(appRegistryStore.getManifest('notes')?.name).toBeTruthy();
    expect(appRegistryStore.getManifest('notes')?.core).toBe(false);
    // Still not a licence to invent apps: an id nothing in the build declares stays undefined.
    expect(appRegistryStore.getManifest('not_a_real_app')).toBeUndefined();
  });

  it('prohibits unregistering built-in core apps', () => {
    expect(() => appRegistryStore.unregisterApp('contacts')).toThrow(
      "gPhone App Registry error: Unregistering core app 'contacts' is prohibited."
    );
  });
});

describe('installFromCatalog', () => {
  const bundleCode = `export const manifest = { id: 'remote_catalog_app' };`;
  const bundleUrl = 'https://store.example.com/apps/catalog_app.js';

  // Computed fresh in `beforeEach` — `sha256Hex` is async, and a per-test hash is
  // clearer than committing a hand-computed hex string that silently goes stale if
  // `bundleCode` above is ever reformatted.
  let catalogEntry: CatalogEntry;

  beforeEach(async () => {
    setTrustedRemoteAppHosts(['store.example.com']);
    vi.restoreAllMocks();
    catalogEntry = {
      id: 'remote_catalog_app',
      name: 'Catalog App',
      version: '1.0.0',
      description: 'A catalog-installed app.',
      bundleUrl,
      sha256: await sha256Hex(bundleCode),
      color: 'bg-emerald-600',
      permissions: ['storage']
    };
  });

  afterEach(() => {
    if (get(appRegistryStore).some((a) => a.id === 'remote_catalog_app')) {
      appRegistryStore.unregisterApp('remote_catalog_app');
    }
  });

  it('installs a bundle whose hash matches the catalog entry, building the manifest from the entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode));

    const result = await appRegistryStore.installFromCatalog(catalogEntry);

    expect(result.manifest.id).toBe('remote_catalog_app');
    expect(result.manifest.name).toBe('Catalog App');
    expect(result.manifest.isRemote).toBe(true);
    expect(result.manifest.bundleUrl).toBe(bundleUrl);
    expect(result.manifest.core).toBe(false);
    expect(result.manifest.permissions).toEqual(['storage']);
    // No component — the registry never ran the fetched code to build a manifest, or a
    // component, from it. `getAddOnSource` is what the sandboxed transport reads.
    expect(appRegistryStore.getComponent('remote_catalog_app')).toBeUndefined();
    await expect(appRegistryStore.getAddOnSource('remote_catalog_app')).resolves.toBe(bundleCode);
  });

  it('refuses to import a bundle whose hash does not match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode + '// tampered'));

    await expect(appRegistryStore.installFromCatalog(catalogEntry)).rejects.toThrow(
      'did not match its published checksum'
    );
    expect(get(appRegistryStore).some((a) => a.id === 'remote_catalog_app')).toBe(false);
  });

  it('refuses a bundleUrl that is not on the trusted host allowlist', async () => {
    setTrustedRemoteAppHosts(['a-different-host.example.com']);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(appRegistryStore.installFromCatalog(catalogEntry)).rejects.toThrow(
      'is not on the trusted remote-app host allowlist'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * `isTrustedRemoteUrl` exempts `data:` URLs for its other, genuinely internal callers —
   * an exemption that assumes nothing produces one from untrusted input. A catalog entry
   * is untrusted input (an operator's catalog server, or a saved/rehydrated row derived
   * from one), so `installVerified` has to reject it itself, before that exemption ever
   * gets a say — the same boundary `nuiMessages.ts`'s `installApp` applies to an NUI
   * payload.
   */
  it('refuses a data: bundleUrl, rather than letting the trusted-host exemption wave it through', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dataEntry: CatalogEntry = {
      ...catalogEntry,
      bundleUrl: 'data:text/javascript,export const manifest = {}'
    };

    await expect(appRegistryStore.installFromCatalog(dataEntry)).rejects.toThrow('data:');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(get(appRegistryStore).some((a) => a.id === 'remote_catalog_app')).toBe(false);
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

  const bundleCode = `export const manifest = { id: 'remote_rehydrate_app' };`;
  const bundleUrl = 'https://store.example.com/apps/rehydrate_app.js';

  const entryFor = (sha256: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry => ({
    id: 'remote_rehydrate_app',
    name: 'Rehydrate App',
    version: '1.0.0',
    description: 'desc',
    bundleUrl,
    sha256,
    color: 'bg-purple-600',
    permissions: [],
    ...overrides
  });

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
    if (get(appRegistryStore).some((a) => a.id === 'remote_rehydrate_app')) {
      appRegistryStore.unregisterApp('remote_rehydrate_app');
    }
    delete (globalThis as any).localStorage;
  });

  it('persists the catalog entry for a catalog install, not just the URL — the pinned hash lives on entry.sha256', async () => {
    const sha256 = await sha256Hex(bundleCode);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode));

    const entry = entryFor(sha256);
    await appRegistryStore.installFromCatalog(entry);

    const stored = JSON.parse(localStorage.getItem('gphone_installed_remote_apps') ?? '[]');
    expect(stored).toEqual([{ url: bundleUrl, entry }]);
  });

  it('re-verifies a hash-pinned install on rehydration and refuses a tampered bundle', async () => {
    // Storage holds the hash pinned at install time; the server now serves something else —
    // exactly what "swapped out after install" looks like.
    const sha256 = await sha256Hex(bundleCode);
    const entry = entryFor(sha256);
    localStorage.setItem(
      'gphone_installed_remote_apps',
      JSON.stringify([{ url: bundleUrl, entry }])
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode + '// tampered'));

    await appRegistryStore.rehydrateSavedRemoteApps();

    expect(get(appRegistryStore).some((a) => a.id === 'remote_rehydrate_app')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`re-hydrate remote app from '${bundleUrl}'`),
      expect.any(Error)
    );
  });

  it('rehydrates a hash-pinned install whose bundle still matches', async () => {
    const sha256 = await sha256Hex(bundleCode);
    const entry = entryFor(sha256);
    localStorage.setItem(
      'gphone_installed_remote_apps',
      JSON.stringify([{ url: bundleUrl, entry }])
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponse(bundleCode));

    await appRegistryStore.rehydrateSavedRemoteApps();

    expect(get(appRegistryStore).some((a) => a.id === 'remote_rehydrate_app')).toBe(true);
    await expect(appRegistryStore.getAddOnSource('remote_rehydrate_app')).resolves.toBe(bundleCode);
  });

  it('replaces a stale pinned hash and entry when the same bundleUrl is reinstalled with a new one', async () => {
    const updatedCode = bundleCode + '// v2';
    const sha256 = await sha256Hex(bundleCode);
    const updatedSha256 = await sha256Hex(updatedCode);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(fetchResponse(bundleCode));

    await appRegistryStore.installFromCatalog(entryFor(sha256));

    fetchSpy.mockResolvedValueOnce(fetchResponse(updatedCode));
    const updatedEntry = entryFor(updatedSha256, { name: 'Rehydrate App v2', version: '1.0.1' });

    await appRegistryStore.installFromCatalog(updatedEntry);

    const stored = JSON.parse(localStorage.getItem('gphone_installed_remote_apps') ?? '[]');
    expect(stored).toEqual([{ url: bundleUrl, entry: updatedEntry }]);
  });

  it('drops a pre-existing saved install with no catalog entry, warning by URL, rather than crashing', async () => {
    // Shapes from before this task: a bare URL string, or `{ url, sha256 }` with nothing
    // to rebuild a manifest from. Neither can be rehydrated any more — this registry
    // never re-runs fetched code to ask it what it is.
    localStorage.setItem(
      'gphone_installed_remote_apps',
      JSON.stringify([bundleUrl, { url: 'https://store.example.com/apps/other.js', sha256: 'x' }])
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await appRegistryStore.rehydrateSavedRemoteApps();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(bundleUrl));
    expect(get(appRegistryStore).some((a) => a.id === 'remote_rehydrate_app')).toBe(false);
  });
});

describe('installed add-on persistence', () => {
  afterEach(() => {
    if (get(appRegistryStore).some((a) => a.id === 'blabber')) {
      appRegistryStore.unregisterApp('blabber');
    }
  });

  it('persists a bundled add-on install and removes it on uninstall', async () => {
    appRegistryStore.registerAddOn({
      id: 'blabber',
      name: 'Blabber',
      color: 'bg-sky-500',
      icon: null,
      core: false
    });
    expect(useStorage('store').getItem<string[]>('installedAddOns')).toEqual(['blabber']);

    appRegistryStore.unregisterApp('blabber');
    expect(useStorage('store').getItem<string[]>('installedAddOns')).toEqual([]);
  });

  it('does not track a remote app in the installed add-on list', async () => {
    const manifest: AppManifest = {
      id: 'remote_installed_addons_test',
      name: 'Remote',
      color: 'bg-gray-600',
      icon: null,
      core: false,
      isRemote: true
    };

    appRegistryStore.registerAddOn(manifest, 'export {}');
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
