// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
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

import {
  appUpdateCount,
  appUpdates,
  computeAppUpdates,
  refreshAppUpdates,
  updateApp
} from './appUpdates';
import { appRegistryStore } from './registry';
import { setRemoteCatalogUrl, type CatalogEntry } from '../../../../sdk/catalog';
import { setTrustedRemoteAppHosts, sha256Hex } from '../../../../sdk/remoteAppSecurity';
import type { AppManifest } from '../../../../sdk/manifest';

const CATALOG_URL = 'https://store.example.com/catalog.json';
const BUNDLE_URL = 'https://store.example.com/apps/weather.js';

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'remote_weather',
  name: 'Weather',
  version: '2.0.0',
  description: 'Live weather.',
  bundleUrl: BUNDLE_URL,
  sha256: 'b'.repeat(64),
  color: 'bg-blue-500',
  permissions: [],
  ...over
});

const installed = (over: Partial<AppManifest> = {}): AppManifest => ({
  id: 'remote_weather',
  name: 'Weather',
  color: 'bg-blue-500',
  tile: { bg: 'bg-blue-500' },
  icon: null,
  core: false,
  isRemote: true,
  bundleUrl: BUNDLE_URL,
  version: '1.0.0',
  ...over
});

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

const textResponse = (text: string): Response =>
  ({ ok: true, status: 200, statusText: '', text: () => Promise.resolve(text) }) as Response;

describe('computeAppUpdates', () => {
  it('reports a catalog version that is newer than the installed one', () => {
    const updates = computeAppUpdates([installed()], [entry()]);

    expect(updates).toEqual([
      {
        appId: 'remote_weather',
        name: 'Weather',
        installedVersion: '1.0.0',
        availableVersion: '2.0.0',
        kind: 'newer',
        entry: entry()
      }
    ]);
  });

  it('reports nothing when the versions match, including across written forms', () => {
    expect(computeAppUpdates([installed({ version: '2.0.0' })], [entry()])).toEqual([]);
    // The string-comparison trap: '2.0' and '2.0.0' are one version, not an endless update.
    expect(computeAppUpdates([installed({ version: '2.0' })], [entry()])).toEqual([]);
    expect(computeAppUpdates([installed({ version: 'v2.0.0+abc' })], [entry()])).toEqual([]);
  });

  it('reports nothing when the catalog is behind the installed copy', () => {
    expect(computeAppUpdates([installed({ version: '3.0.0' })], [entry()])).toEqual([]);
  });

  it('ignores a bundled add-on, whose code is part of this build', () => {
    // Nowhere newer to get it from — its version is the phone's own, and offering an
    // "update" would point at a bundle that is not this app's.
    const bundled = installed({ isRemote: false, bundleUrl: undefined });
    expect(computeAppUpdates([bundled], [entry()])).toEqual([]);
  });

  it('ignores an installed app the catalog no longer lists', () => {
    expect(computeAppUpdates([installed()], [entry({ id: 'something_else' })])).toEqual([]);
  });

  it('flags an unorderable pair as a mismatch rather than claiming it is newer', () => {
    // An operator who publishes 'nightly' still published something. Saying nothing would
    // be the silent "up to date" this whole feature exists to stop.
    const updates = computeAppUpdates(
      [installed({ version: '1.0.0' })],
      [entry({ version: 'nightly' })]
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].kind).toBe('unordered');
    expect(updates[0].availableVersion).toBe('nightly');
  });

  it('says nothing when an unorderable version is the same string on both sides', () => {
    const updates = computeAppUpdates(
      [installed({ version: 'nightly' })],
      [entry({ version: 'nightly' })]
    );

    expect(updates).toEqual([]);
  });
});

describe('refreshAppUpdates', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setTrustedRemoteAppHosts(['store.example.com']);
    setRemoteCatalogUrl(undefined);
  });

  afterEach(async () => {
    setRemoteCatalogUrl(undefined);
    await refreshAppUpdates();
    if (get(appRegistryStore).some((a) => a.id === 'remote_weather')) {
      appRegistryStore.unregisterApp('remote_weather');
    }
  });

  it('fetches nothing and reports nothing with no catalog configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(refreshAppUpdates()).resolves.toEqual([]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(get(appUpdateCount)).toBe(0);
  });

  it('finds an installed add-on the catalog has moved past', async () => {
    appRegistryStore.registerAddOn(installed(), 'export default {};');
    setRemoteCatalogUrl(CATALOG_URL);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([entry()]));

    const updates = await refreshAppUpdates();

    expect(updates.map((u) => u.appId)).toEqual(['remote_weather']);
    expect(get(appUpdates)).toEqual(updates);
    expect(get(appUpdateCount)).toBe(1);
  });

  it('keeps the last known answer when the catalog cannot be reached', async () => {
    // A catalog server that is down is not evidence anybody is up to date. Dropping the
    // pending update on a blip is the same silent reassurance this exists to prevent.
    appRegistryStore.registerAddOn(installed(), 'export default {};');
    setRemoteCatalogUrl(CATALOG_URL);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([entry()]));
    await refreshAppUpdates();

    fetchSpy.mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const updates = await refreshAppUpdates();

    expect(updates.map((u) => u.appId)).toEqual(['remote_weather']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(CATALOG_URL), 'network down');
  });

  it('drops the row when the app is uninstalled, without another fetch', async () => {
    // The list is derived from the registry rather than assembled once, so nothing has to
    // remember to prune it.
    appRegistryStore.registerAddOn(installed(), 'export default {};');
    setRemoteCatalogUrl(CATALOG_URL);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([entry()]));
    await refreshAppUpdates();
    expect(get(appUpdateCount)).toBe(1);

    appRegistryStore.unregisterApp('remote_weather');

    expect(get(appUpdateCount)).toBe(0);
  });
});

describe('updateApp', () => {
  const bundle = 'export const weather = 2;';

  beforeEach(() => {
    vi.restoreAllMocks();
    setTrustedRemoteAppHosts(['store.example.com']);
    setRemoteCatalogUrl(CATALOG_URL);
  });

  afterEach(async () => {
    setRemoteCatalogUrl(undefined);
    await refreshAppUpdates();
    if (get(appRegistryStore).some((a) => a.id === 'remote_weather')) {
      appRegistryStore.unregisterApp('remote_weather');
    }
  });

  it('refuses an app with nothing pending rather than reinstalling blind', async () => {
    await expect(updateApp('remote_weather')).rejects.toThrow(
      "No update is available for 'remote_weather'."
    );
  });

  it('installs the catalog copy through the ordinary verified install path', async () => {
    // Reuse, not a second path: `installFromCatalog` re-fetches and re-checks the entry's
    // sha256, so an update cannot skip the verification a first install does.
    appRegistryStore.registerAddOn(installed(), 'stale bundle');
    const sha256 = await sha256Hex(bundle);
    const fresh = entry({ version: '2.0.0', sha256 });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse([fresh]));
    await refreshAppUpdates();
    expect(get(appUpdateCount)).toBe(1);

    const installSpy = vi.spyOn(appRegistryStore, 'installFromCatalog');
    fetchSpy.mockResolvedValueOnce(textResponse(bundle));

    const manifest = await updateApp('remote_weather');

    expect(installSpy).toHaveBeenCalledWith(fresh);
    expect(manifest.version).toBe('2.0.0');
    await expect(appRegistryStore.getAddOnSource('remote_weather')).resolves.toBe(bundle);
    // The installed version now matches the catalog, so the row is gone without a refetch.
    expect(get(appUpdateCount)).toBe(0);
  });

  it('leaves the update pending when the fresh bundle fails its checksum', async () => {
    appRegistryStore.registerAddOn(installed(), 'stale bundle');
    const fresh = entry({ version: '2.0.0', sha256: await sha256Hex(bundle) });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse([fresh]));
    await refreshAppUpdates();

    fetchSpy.mockResolvedValueOnce(textResponse(bundle + '// tampered'));

    await expect(updateApp('remote_weather')).rejects.toThrow('published checksum');
    expect(get(appUpdateCount)).toBe(1);
    await expect(appRegistryStore.getAddOnSource('remote_weather')).resolves.toBe('stale bundle');
  });
});
