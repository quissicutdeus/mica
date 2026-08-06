import { describe, it, expect, vi } from 'vitest';
import type { AppComponent } from '@gphone/sdk';
import { get } from 'svelte/store';
import { appRegistryStore, registeredApps, getFirstBootTime, type AppManifest } from './registry';

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
  it('keeps a bundled add-on mountable across uninstall and reinstall', () => {
    const blabber = get(appRegistryStore).find((a) => a.id === 'blabber');
    // Blabber ships `core: false`, so it starts uninstalled and the glob is the only thing that
    // has ever supplied its component.
    expect(blabber).toBeUndefined();

    const bundled = appRegistryStore.getComponent('blabber');
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
});
