import { describe, it, expect } from 'vitest';
import type { AppComponent } from '@gphone/sdk';
import { get } from 'svelte/store';
import { appRegistryStore, registeredApps, getFirstBootTime, type AppManifest } from './registry';

describe('App Registry Store', () => {
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
      icon: null
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

  it('prohibits unregistering built-in system apps', () => {
    expect(() => appRegistryStore.unregisterApp('contacts')).toThrow(
      "gPhone App Registry error: Unregistering system app 'contacts' is prohibited."
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
});
