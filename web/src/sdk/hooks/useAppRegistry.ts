import { appRegistryStore, getFirstBootTime } from '../../store/registry';
import type { AppManifest } from '../manifest';

/**
 * OS Service Hook for dynamic app registry & remote app installation.
 */
export function useAppRegistry() {
  return {
    registryStore: appRegistryStore,
    getFirstBootTime: () => getFirstBootTime(),
    loadRemoteApp: (url: string) => appRegistryStore.loadRemoteApp(url),
    registerApp: (manifest: AppManifest, component: any) =>
      appRegistryStore.registerApp(manifest, component),
    unregisterApp: (appId: string) => appRegistryStore.unregisterApp(appId)
  };
}
