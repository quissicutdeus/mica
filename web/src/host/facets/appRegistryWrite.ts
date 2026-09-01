// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { appRegistryStore } from '../../shell/state/registry';
import { refreshAppUpdates, updateApp } from '../../shell/state/appUpdates';
import type { AppComponent, AppManifest } from '../../../../sdk/manifest';
import type { CatalogEntry } from '../../../../sdk/catalog';

/**
 * Implementation of the `useAppRegistryWrite` facet — see the `useAppRegistryWrite` hook
 * doc for the usage contract. Split out of `appRegistry` (MICA-127): listing installed
 * apps and installing or removing one are not the same ask — `app-registry`'s own label in
 * the Store ("Install & Remove Apps") already said as much; this is what makes the
 * *permission* match that disclosure instead of granting the read half's declarer both.
 */
export function appRegistryWrite() {
  return {
    /** Re-check the configured catalog. Safe with none configured: the list empties. */
    refreshUpdates: () => refreshAppUpdates(),
    /** Install the catalog's copy of a pending update, through the ordinary verified install path. */
    updateApp: (appId: string) => updateApp(appId),
    installFromCatalog: (entry: CatalogEntry) => appRegistryStore.installFromCatalog(entry),
    registerApp: (manifest: AppManifest, component: AppComponent) =>
      appRegistryStore.registerApp(manifest, component),
    registerAddOn: (manifest: AppManifest, source?: string) =>
      appRegistryStore.registerAddOn(manifest, source),
    unregisterApp: (appId: string) => appRegistryStore.unregisterApp(appId)
  };
}

registerFacet('appRegistryWrite', appRegistryWrite);
