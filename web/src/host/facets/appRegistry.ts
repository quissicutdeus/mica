// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { registerFacet } from '../../../../sdk/host/current';
import { appRegistryStore, bundledAddOns, getFirstBootTime } from '../../shell/state/registry';
import { appUpdateCount, appUpdates } from '../../shell/state/appUpdates';
import { disabledAppIds } from '../../shell/state/ownerConfig';

/**
 * OS Service Hook for the app registry — read-only. Installing, removing, or updating an
 * app is `useAppRegistryWrite` (MICA-127).
 */
export function appRegistry() {
  return {
    registryStore: appRegistryStore,
    /**
     * Add-ons this repo ships uninstalled — what the Store has to offer beyond remotes.
     *
     * Filtered fresh on every call (MICA-234), not a stored snapshot: `bundledAddOns` itself
     * is a fact about the build, written once at startup, so the owner's disabled list is
     * applied here rather than there — an app the owner disables must stop being offered by
     * the Store without waiting for a rebuild.
     */
    bundledAddOns: bundledAddOns.filter((m) => !get(disabledAppIds).has(m.id)),
    getFirstBootTime: () => getFirstBootTime(),
    /** Installed catalog add-ons the catalog has moved past (MICA-74). */
    updatesStore: appUpdates,
    /** The same list as a count, for the Store's launcher badge. */
    updateCount: appUpdateCount
  };
}

registerFacet('appRegistry', appRegistry);
