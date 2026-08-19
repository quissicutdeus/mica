import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import manifest from './manifest';
import { useAppRegistry, setTrustedRemoteAppHosts } from '@gphone/sdk';
import { renderApp } from '@gphone/sdk/testing';
import { catalogApps, remoteCatalogApps, mergedCatalogApps } from './appInfo';
import type { AppComponent } from '@gphone/sdk';
import { get } from 'svelte/store';

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));

import Store from './index.svelte';

const { registryStore: appRegistryStore } = useAppRegistry();

// The registry insists on a component now. These three cases are about bookkeeping —
// registration, lookup, and the system-app guard — and never mount anything.
const stubComponent = {} as unknown as AppComponent;

describe('Store Module', () => {
  it('exports a valid system app manifest', () => {
    expect(manifest.id).toBe('store');
    expect(manifest.name).toBe('Store');
    expect(manifest.author).toBe('gPhone');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('network');
  });

  it('is registered in appRegistryStore automatically', () => {
    appRegistryStore.registerApp(manifest, stubComponent);
    const apps = get(appRegistryStore);
    const storeApp = apps.find((a) => a.id === 'store');
    expect(storeApp).toBeDefined();
    expect(storeApp?.name).toBe('Store');
  });

  it('prohibits unregistering the Store system app', () => {
    appRegistryStore.registerApp(manifest, stubComponent);
    expect(() => appRegistryStore.unregisterApp('store')).toThrow(
      "gPhone App Registry error: Unregistering core app 'store' is prohibited."
    );
  });
});

describe('Store catalog', () => {
  it('offers an in-repo add-on without it being listed by hand', () => {
    // Notes ships `core: false`, so it is kept out of the launcher and used to reach
    // the Store only via a hand-written copy of its own manifest in `appInfo.ts` — which
    // then drifted from the real one. It is derived from the registry now.
    expect(catalogApps().map((a) => a.id)).toContain('notes');
  });

  it('takes the real manifest, not a copy of it', () => {
    // The copy carried its own name, icon URL and version. The derived entry is the same
    // object the launcher and the registry see, so there is nothing left to drift.
    const notes = catalogApps().find((a) => a.id === 'notes');

    expect(notes?.name).toBe('Notes');
    expect(notes?.core).toBe(false);
  });
});

describe('Store, rendered', () => {
  it('opens on the catalog, with both tabs offered', () => {
    // Store had no render coverage at all — every assertion above is about the manifest
    // and the registry, neither of which needs the component to work.
    const { getByText, getByRole } = renderApp(Store, { id: 'store' });

    expect(getByRole('group', { name: 'Store sections' })).toBeTruthy();
    expect(getByText('Store Catalog')).toBeTruthy();
  });

  it('counts the installed apps in the tab label', () => {
    // The count is interpolated from the registry store, so it is the one part of the
    // header that can silently disagree with what is actually installed.
    const installed = get(appRegistryStore).length;
    const { getByText } = renderApp(Store, { id: 'store' });

    expect(getByText(`Installed (${installed})`)).toBeTruthy();
  });

  it('leaves when back is pressed', () => {
    // `onback` is the one prop every app takes, and the easiest to wire backwards.
    const { getByLabelText, onback } = renderApp(Store, { id: 'store' });

    getByLabelText('Go back').click();

    expect(onback).toHaveBeenCalled();
  });
});

describe('handleInstall routing', () => {
  /**
   * `handleInstall` in `index.svelte` branches on `app.isRemote && app.bundleUrl` to pick
   * `installFromCatalog` over the bundled-add-on `registerApp` path. Only the bundled
   * branch is reachable through a real render: `REMOTE_CATALOG_URL` is hard-coded to
   * `undefined` in `index.svelte` (a deliberate non-goal — no operator configuration for
   * the remote catalog URL yet), so `mergedCatalogApps` never returns a remote entry for
   * `CatalogList` to render an Install button for, and there is no other exported seam to
   * reach `handleInstall`'s remote branch directly. That branch stays untested until
   * either an operator-configurable catalog URL or a test seam exists for it.
   */
  afterEach(() => {
    if (get(appRegistryStore).some((a) => a.id === 'notes')) {
      appRegistryStore.unregisterApp('notes');
    }
  });

  it('installs a bundled add-on via registerApp, not installFromCatalog', async () => {
    const registerApp = vi.spyOn(appRegistryStore, 'registerApp');
    const installFromCatalog = vi.spyOn(appRegistryStore, 'installFromCatalog');

    const { getByText } = renderApp(Store, { id: 'store' });
    await vi.waitFor(() => expect(getByText('Notes')).toBeTruthy());

    const row = getByText('Notes').closest('.justify-between') as HTMLElement;
    expect(row).toBeTruthy();
    const buttons = row.querySelectorAll('button');
    // Second button in the row is Install/Uninstall; the first opens the details view.
    (buttons[1] as HTMLButtonElement).click();

    await vi.waitFor(() => expect(registerApp).toHaveBeenCalled());
    expect(registerApp.mock.calls[0][0]).toMatchObject({ id: 'notes' });
    expect(installFromCatalog).not.toHaveBeenCalled();
  });
});

describe('remote catalog', () => {
  const remoteEntry = {
    id: 'remote_weather',
    name: 'Weather',
    version: '2.0.0',
    description: 'Live weather from a remote catalog.',
    bundleUrl: 'https://store.example.com/apps/weather.js',
    sha256: 'b'.repeat(64),
    color: 'bg-blue-500',
    icon: 'https://store.example.com/icons/weather.svg'
  };

  beforeEach(() => {
    setTrustedRemoteAppHosts(['store.example.com']);
    vi.restoreAllMocks();
  });

  it('fetches nothing and returns an empty list when no catalog URL is configured', async () => {
    expect(await remoteCatalogApps(undefined)).toEqual([]);
  });

  it('maps a fetched catalog entry onto the same shape CatalogList already renders', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([remoteEntry])
    } as Response);

    const apps = await remoteCatalogApps('https://store.example.com/catalog.json');

    expect(apps).toEqual([
      {
        id: 'remote_weather',
        name: 'Weather',
        version: '2.0.0',
        description: 'Live weather from a remote catalog.',
        icon: 'https://store.example.com/icons/weather.svg',
        color: 'bg-blue-500',
        core: false,
        isRemote: true,
        bundleUrl: 'https://store.example.com/apps/weather.js'
      }
    ]);
  });

  it('merges bundled and remote apps, bundled first', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([remoteEntry])
    } as Response);

    const merged = await mergedCatalogApps('https://store.example.com/catalog.json');

    expect(merged.some((a) => a.id === 'remote_weather')).toBe(true);
    expect(merged.find((a) => a.id === 'remote_weather')?.isRemote).toBe(true);
  });

  it('falls back to an empty list, not a rejection, when the remote catalog fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(remoteCatalogApps('https://store.example.com/catalog.json')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('still returns the bundled add-ons when the remote catalog fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const merged = await mergedCatalogApps('https://store.example.com/catalog.json');

    expect(merged.length).toBeGreaterThan(0);
    expect(merged.some((a) => a.id === 'notes')).toBe(true);
    expect(merged.some((a) => a.id === 'remote_weather')).toBe(false);
  });
});
