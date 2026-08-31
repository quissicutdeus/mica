import { registerFacet } from '../../../../sdk/host/current';
import { appRegistryStore, bundledAddOns, getFirstBootTime } from '../../shell/state/registry';
import { appUpdateCount, appUpdates } from '../../shell/state/appUpdates';

/**
 * OS Service Hook for the app registry — read-only. Installing, removing, or updating an
 * app is `useAppRegistryWrite` (MICA-127).
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
    updateCount: appUpdateCount
  };
}

registerFacet('appRegistry', appRegistry);
