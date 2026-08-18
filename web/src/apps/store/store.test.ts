import { describe, it, expect, vi } from 'vitest';
import manifest from './manifest';
import { useAppRegistry } from '@gphone/sdk';
import { renderApp } from '@gphone/sdk/testing';
import { catalogApps } from './appInfo';
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
