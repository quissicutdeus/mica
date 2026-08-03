import { appRegistryStore, bundledAddOns, getFirstBootTime } from '../../shell/state/registry';
import type { AppComponent, AppManifest } from '../manifest';

/**
 * OS Service Hook for dynamic app registry & remote app installation.
 */
export function useAppRegistry() {
  return {
    registryStore: appRegistryStore,
    /** Add-ons this repo ships uninstalled — what the Store has to offer beyond remotes. */
    bundledAddOns,
    getFirstBootTime: () => getFirstBootTime(),
    loadRemoteApp: (url: string) => appRegistryStore.loadRemoteApp(url),
    registerApp: (manifest: AppManifest, component: AppComponent) =>
      appRegistryStore.registerApp(manifest, component),
    unregisterApp: (appId: string) => appRegistryStore.unregisterApp(appId)
  };
}
