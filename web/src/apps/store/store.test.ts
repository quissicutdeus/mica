// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import manifest from './manifest';
import {
  useAppRegistry,
  useAppRegistryWrite,
  setTrustedRemoteAppHosts,
  setRemoteCatalogUrl
} from '@gphone/sdk';
import type { AppManifest } from '@gphone/sdk';
import { renderApp } from '@gphone/sdk/testing';
import { catalogApps, remoteCatalogApps, mergedCatalogApps } from './appInfo';
import type { AppComponent } from '@gphone/sdk';
import { get } from 'svelte/store';

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(async () => null),
  isBrowser: () => true
}));

import Store from './index.svelte';

/**
 * jsdom ships no Web Animations API, and Svelte's transitions call `element.animate` — so
 * the first test here to actually open a `ConfirmDialog` (MICA-196's permission prompt)
 * threw during the dialog's own transition, *after* its assertions, as an uncaught
 * exception that failed the run without failing a test.
 *
 * The same stub, in the same shape, as `AppDrawer.test.ts`, `ToastHost.test.ts`,
 * `Dock.test.ts` and `PhoneFrame.test.ts` — every suite in this tree that renders something
 * with a transition carries one.
 */
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const { registryStore: appRegistryStore } = useAppRegistry();
const { refreshUpdates } = useAppRegistryWrite();

// The registry insists on a component now. These three cases are about bookkeeping —
// registration, lookup, and the system-app guard — and never mount anything.
const stubComponent = {} as unknown as AppComponent;

describe('Store Module', () => {
  it('exports a valid system app manifest', () => {
    expect(manifest.id).toBe('store');
    expect(manifest.name).toBe('Store');
    expect(manifest.author).toBe('gPhone');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.requiresNetwork).toBe(true);
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
   * `installFromCatalog` over the bundled-add-on `registerAddOn` path. This block covers
   * the bundled branch; `setRemoteCatalogUrl` (MICA-74 moved the URL out of a `const` in
   * `index.svelte` and into `shell/state/catalog.ts`, because the update check needs the
   * same answer at phone-open) is the seam the remote branch was previously missing.
   */
  afterEach(() => {
    if (get(appRegistryStore).some((a) => a.id === 'notes')) {
      appRegistryStore.unregisterApp('notes');
    }
  });

  it('installs a bundled add-on via registerAddOn, not installFromCatalog', async () => {
    const registerAddOn = vi.spyOn(appRegistryStore, 'registerAddOn');
    const installFromCatalog = vi.spyOn(appRegistryStore, 'installFromCatalog');

    const { getByText } = renderApp(Store, { id: 'store' });
    await vi.waitFor(() => expect(getByText('Notes')).toBeTruthy());

    const row = getByText('Notes').closest('.justify-between') as HTMLElement;
    expect(row).toBeTruthy();
    const buttons = row.querySelectorAll('button');
    // Second button in the row is Install/Uninstall; the first opens the details view.
    buttons[1].click();

    await vi.waitFor(() => expect(registerAddOn).toHaveBeenCalled());
    expect(registerAddOn.mock.calls[0][0]).toMatchObject({ id: 'notes' });
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
    icon: 'https://store.example.com/icons/weather.svg',
    permissions: ['storage'] as const
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
        // Split out of the wire field, so a remote listing carries the same structured
        // tile a bundled manifest does (MICA-91). The catalog itself still speaks
        // `color`; that is a published format and stays a string.
        tile: { bg: 'bg-blue-500' },
        core: false,
        isRemote: true,
        bundleUrl: 'https://store.example.com/apps/weather.js',
        permissions: ['storage'],
        requiresNetwork: false
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

  it('lists one row per id when the catalog offers an add-on this build also ships', async () => {
    // Found the first time a real catalog was ever fetched (MICA-126). `CatalogList`
    // keys its `{#each}` on `id`, so two rows for `notes` threw `each_key_duplicate` and
    // the Store crashed to `AppCrashed` — no listing, no install, nothing to retry but a
    // Restart button. The four ids gPhone ships are exactly the ones an operator is most
    // likely to republish, so this is the first thing anybody would have hit.
    const shadowing = {
      ...remoteEntry,
      id: 'notes',
      name: 'Notes',
      bundleUrl: 'https://store.example.com/apps/notes.js'
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([shadowing])
    } as Response);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const merged = await mergedCatalogApps('https://store.example.com/catalog.json');

    expect(merged.filter((a) => a.id === 'notes')).toHaveLength(1);
    // The catalog's copy, not the bundled one: it is what the operator configured, and the
    // only one of the two that carries a hash and can ever be updated.
    expect(merged.find((a) => a.id === 'notes')?.isRemote).toBe(true);
    expect(warn).toHaveBeenCalled();
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

describe('add-on updates (MICA-74)', () => {
  const BUNDLE_URL = 'https://store.example.com/apps/weather.js';
  const CATALOG_URL = 'https://store.example.com/catalog.json';

  const catalogEntry = {
    id: 'remote_weather',
    name: 'Weather',
    version: '2.0.0',
    description: 'Live weather from a remote catalog.',
    bundleUrl: BUNDLE_URL,
    sha256: 'b'.repeat(64),
    color: 'bg-blue-500',
    permissions: []
  };

  const installedManifest = {
    id: 'remote_weather',
    name: 'Weather',
    color: 'bg-blue-500',
    tile: { bg: 'bg-blue-500' },
    icon: null,
    core: false,
    isRemote: true,
    bundleUrl: BUNDLE_URL,
    version: '1.0.0'
  } as unknown as AppManifest;

  beforeEach(() => {
    vi.restoreAllMocks();
    setTrustedRemoteAppHosts(['store.example.com']);
    setRemoteCatalogUrl(CATALOG_URL);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([catalogEntry])
    } as Response);
    appRegistryStore.registerAddOn(installedManifest, 'v1 bundle');
  });

  afterEach(async () => {
    setRemoteCatalogUrl(undefined);
    await refreshUpdates();
    if (get(appRegistryStore).some((a) => a.id === 'remote_weather')) {
      appRegistryStore.unregisterApp('remote_weather');
    }
  });

  it('tells a player on either tab that an installed add-on is behind', async () => {
    // The banner sits above the tabs on purpose: a player arriving from the launcher badge
    // has no idea which tab the news is on.
    const { findByText } = renderApp(Store, { id: 'store' });

    expect(await findByText('1 add-on has an update available')).toBeTruthy();
  });

  it('offers Update on the installed row, naming both versions', async () => {
    const { findByText, getByText } = renderApp(Store, { id: 'store' });
    await findByText('1 add-on has an update available');

    getByText('Installed (' + get(appRegistryStore).length + ')').click();

    expect(await findByText('Update available · v1.0.0 → v2.0.0')).toBeTruthy();
    expect(getByText('Update')).toBeTruthy();
  });

  it('updates through installFromCatalog rather than a second install path', async () => {
    // Reuse is the whole rule here: the update re-fetches and re-verifies the entry's
    // sha256 exactly as a first install does.
    const installFromCatalog = vi
      .spyOn(appRegistryStore, 'installFromCatalog')
      .mockResolvedValue({ manifest: installedManifest });

    const { findByText, getByText } = renderApp(Store, { id: 'store' });
    await findByText('1 add-on has an update available');
    getByText('Installed (' + get(appRegistryStore).length + ')').click();

    (await findByText('Update')).click();

    await vi.waitFor(() => expect(installFromCatalog).toHaveBeenCalledWith(catalogEntry));
  });

  /**
   * MICA-196. A catalog entry is remote data that moves underneath an installed app, and
   * the Update button sits on a row showing a version number. An add-on installed reading
   * nothing could republish asking for contacts and messages, and the old path installed
   * that in one tap — the disclosure the player agreed to at install was simply replaced.
   */
  describe('an update that wants more than the installed version was granted', () => {
    const grabbier = () =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ ...catalogEntry, permissions: ['contacts'] }])
      } as Response);

    /** Through the banner, to the Installed tab, to the row's Update button. */
    const reachUpdateButton = async () => {
      const screen = renderApp(Store, { id: 'store' });
      await screen.findByText('1 add-on has an update available');
      screen.getByText('Installed (' + get(appRegistryStore).length + ')').click();
      (await screen.findByText('Update')).click();
      return screen;
    };

    it('asks first, naming what is new, and installs nothing yet', async () => {
      grabbier();
      const installFromCatalog = vi
        .spyOn(appRegistryStore, 'installFromCatalog')
        .mockResolvedValue({ manifest: installedManifest });

      const { findByText } = await reachUpdateButton();

      expect(await findByText('Weather wants more access')).toBeTruthy();
      // The player's label for the permission, not the vocabulary name — this dialog is
      // the disclosure, so it has to read the way `AppDetails` does.
      expect(await findByText(/adds: Contacts/)).toBeTruthy();
      expect(installFromCatalog).not.toHaveBeenCalled();
    });

    it('installs once the player accepts', async () => {
      grabbier();
      const installFromCatalog = vi
        .spyOn(appRegistryStore, 'installFromCatalog')
        .mockResolvedValue({ manifest: installedManifest });

      const { findByText } = await reachUpdateButton();
      (await findByText('Update anyway')).click();

      await vi.waitFor(() => expect(installFromCatalog).toHaveBeenCalled());
    });

    /**
     * Refusing is refusing the permissions, not merely the dialog: an add-on's declared
     * permissions live on its installed manifest, and the shell re-checks every call
     * against that manifest, so a version that was never installed cannot exercise them.
     */
    it('leaves the installed version alone when the player declines', async () => {
      grabbier();
      const installFromCatalog = vi
        .spyOn(appRegistryStore, 'installFromCatalog')
        .mockResolvedValue({ manifest: installedManifest });

      const { findByText } = await reachUpdateButton();
      (await findByText('Keep this version')).click();

      // Nothing is fetched, nothing is verified, nothing replaces the installed manifest —
      // which is where the permissions the shell enforces actually live.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(installFromCatalog).not.toHaveBeenCalled();
    });

    it('does not ask when the update adds nothing — a trained yes is not consent', async () => {
      // The suite's default catalog entry declares the same (empty) permission set the
      // installed manifest holds, which is the ordinary case.
      const installFromCatalog = vi
        .spyOn(appRegistryStore, 'installFromCatalog')
        .mockResolvedValue({ manifest: installedManifest });

      const { queryByText } = await reachUpdateButton();

      await vi.waitFor(() => expect(installFromCatalog).toHaveBeenCalled());
      expect(queryByText('Weather wants more access')).toBeNull();
    });
  });

  it('says nothing when the catalog matches what is installed', async () => {
    appRegistryStore.unregisterApp('remote_weather');
    appRegistryStore.registerAddOn({ ...installedManifest, version: '2.0.0' }, 'v2 bundle');

    const { queryByText, findByText } = renderApp(Store, { id: 'store' });
    await findByText('Store Catalog');

    await vi.waitFor(() => expect(queryByText(/update available/)).toBeNull());
  });
});
