// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for the app registry — read-only: the installed list, the bundled
 * add-ons the Store can offer, and the update queue. Installing, removing, or updating an
 * app is `useAppRegistryWrite` (MICA-127) — see its own doc for why every mutating
 * member throws inside a sandboxed add-on regardless of what its manifest declares.
 *
 * An app the server owner has disabled (`mica_disabled_apps`, MICA-234) is in no answer
 * this hook gives: not the installed list, not `bundledAddOns`, not a lookup by id. The list
 * updates live when the owner's configuration arrives, so from an app — core or add-on — a
 * disabled app is one that does not exist. `ownerDisabledApps.test.ts` holds both sides of
 * the wire to that.
 */
export function useAppRegistry() {
  return guarded('useAppRegistry').facets.appRegistry();
}
