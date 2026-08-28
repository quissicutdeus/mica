import { registerFacet } from '../../current';
import {
  appRegistryStore,
  bundledAddOns,
  getFirstBootTime
} from '../../../../shell/state/registry';
import {
  appUpdateCount,
  appUpdates,
  refreshAppUpdates,
  updateApp
} from '../../../../shell/state/appUpdates';
import type { AppComponent, AppManifest } from '../../../manifest';
import type { CatalogEntry } from '../../../../shell/state/catalog';

/**
 * OS Service Hook for dynamic app registry & remote app installation.
 */
export function appRegistry() {
  return {
    registryStore: appRegistryStore,
    /** Add-ons this repo ships uninstalled — what the Store has to offer beyond remotes. */
    bundledAddOns,
    getFirstBootTime: () => getFirstBootTime(),
    /** Installed catalog add-ons the catalog has moved past (MICA-74). */
    updatesStore: appUpdates,
    /** The same list as a count, for the Store's launcher badge. */
    updateCount: appUpdateCount,
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

registerFacet('appRegistry', appRegistry);
