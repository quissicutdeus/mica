import { registerFacet } from '../../current';
import {
  appRegistryStore,
  bundledAddOns,
  getFirstBootTime
} from '../../../../shell/state/registry';
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
    loadRemoteApp: (url: string) => appRegistryStore.loadRemoteApp(url),
    installFromCatalog: (entry: CatalogEntry) => appRegistryStore.installFromCatalog(entry),
    registerApp: (manifest: AppManifest, component: AppComponent) =>
      appRegistryStore.registerApp(manifest, component),
    unregisterApp: (appId: string) => appRegistryStore.unregisterApp(appId)
  };
}

registerFacet('appRegistry', appRegistry);
