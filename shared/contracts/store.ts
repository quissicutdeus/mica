// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';

/**
 * The add-on catalog, fetched by the server on the phones' behalf (MICA-237).
 *
 * A phone used to fetch the catalog itself, at boot and on every update check, which told
 * the catalog's host the IP address of every player on the server. With a public catalog on
 * by default that host is the project's, so the server fetches it instead, caches it, and
 * answers this action: the catalog's host sees the server, never a player. Bundles are still
 * fetched by the phone: at install, and at every boot to rehydrate what is installed.
 *
 * `entries` is the catalog exactly as the host served it, unvalidated. The shell validates
 * every entry with `isCatalogEntry` and re-hashes every bundle it fetches, as it always did;
 * relaying the JSON through the server changes who asks, not what is trusted.
 */
export type StoreCatalogResult =
  | { status: 'ok'; entries: unknown[] }
  /** `mica_addon_catalog` is `off`: remote add-ons are disabled on this server. */
  | { status: 'off' }
  /** The catalog could not be fetched or was not a JSON array. Logged on the server. */
  | { status: 'unavailable' };

export const storeContract = defineContract({
  id: 'store',
  actions: {
    /** The configured catalog's entries, from the server's cache when it is fresh. */
    catalog: { input: s.none(), output: responseType<StoreCatalogResult>() }
  }
});
