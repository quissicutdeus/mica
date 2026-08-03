import { describe, it, expect, vi } from 'vitest';
import manifest from './manifest';
import { useAppRegistry } from '@gphone/sdk';
import { renderApp } from '@gphone/sdk/testing';
import { get } from 'svelte/store';

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));

import Store from './index.svelte';

const { registryStore: appRegistryStore } = useAppRegistry();

describe('Store Module', () => {
  it('exports a valid system app manifest', () => {
    expect(manifest.id).toBe('store');
    expect(manifest.name).toBe('Store');
    expect(manifest.author).toBe('gPhone');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('network');
  });

  it('is registered in appRegistryStore automatically', () => {
    appRegistryStore.registerApp(manifest, {});
    const apps = get(appRegistryStore);
    const storeApp = apps.find((a) => a.id === 'store');
    expect(storeApp).toBeDefined();
    expect(storeApp?.name).toBe('Store');
  });

  it('prohibits unregistering the Store system app', () => {
    appRegistryStore.registerApp(manifest, {});
    expect(() => appRegistryStore.unregisterApp('store')).toThrow(
      "gPhone App Registry error: Unregistering system app 'store' is prohibited."
    );
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
    // Note the label: Store hand-rolls its header rather than using `ScreenHeader`, so
    // its button reads "Back to Home" where every other app's reads "Go back".
    const { getByLabelText, onback } = renderApp(Store, { id: 'store' });

    getByLabelText('Back to Home').click();

    expect(onback).toHaveBeenCalled();
  });
});
