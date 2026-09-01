// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readable } from 'svelte/store';
import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['appRegistry']>>;

/**
 * OS Service Hook for the app registry, seen from inside a sandboxed add-on — read-only.
 * Installing, removing or updating an app is `useAppRegistryWrite`
 * (`iframe/facets/appRegistryWrite.ts`), whose members `IframeHostServer`'s
 * `MEMBER_ALLOWLIST` still refuses regardless of permission — an add-on never installs or
 * removes apps, full stop.
 */
export function appRegistry(): Twin {
  return {
    registryStore: store('appRegistry', [], 'registryStore', []),
    /** Add-ons don't list add-ons. */
    bundledAddOns: [],
    // Sync in-process (reads a cached value); async over the wire.
    getFirstBootTime: fn(
      'appRegistry',
      [],
      'getFirstBootTime'
    ) as unknown as Twin['getFirstBootTime'],
    /**
     * Empty rather than a `store()` round trip: `MEMBER_ALLOWLIST` does not list these, so
     * the wire call would be refused anyway, and an add-on has no business enumerating what
     * else the player has installed or how far behind it is.
     */
    updatesStore: readable([]),
    updateCount: readable(0)
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('appRegistry', appRegistry as unknown as Facets['appRegistry']);
