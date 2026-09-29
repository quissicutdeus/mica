// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { storeContract } from '@mica/shared/contracts/store';
import { callOr } from '../../nui/call';
import { isCatalogEntry, type CatalogEntry } from '../../../../sdk/catalog';

/**
 * What the server made of the add-on catalog (MICA-237).
 *
 * - `ok`: the entries, each already checked with `isCatalogEntry`.
 * - `off`: the operator disabled remote add-ons. Nothing remote is listed, nothing is
 *   checked for updates.
 * - `unavailable`: the server could not fetch a catalog, or what came back was not one.
 *   The caller shows bundled add-ons only and keeps whatever it last knew.
 */
export type RemoteCatalog =
  { status: 'ok'; entries: CatalogEntry[] } | { status: 'off' } | { status: 'unavailable' };

const UNAVAILABLE: RemoteCatalog = { status: 'unavailable' };

/**
 * The one place the phone learns what the catalog offers.
 *
 * The phone used to fetch the catalog itself, at boot and on every update check, which told
 * the catalog's host the address of every player. The server fetches and caches it now
 * (`shared/contracts/store.ts`), and this asks the server. The Store's listing, its install
 * lookup and the update check all read it here, so there is one validation and one answer
 * to "is the catalog off".
 *
 * What the server relays is the host's JSON, unvalidated, and this is where it stops being
 * trusted: a row that fails `isCatalogEntry` is dropped and logged, not the whole catalog,
 * exactly as `fetchCatalog` treated a row it fetched itself. A bundle is still fetched by
 * the phone and re-hashed against its entry's `sha256` at install; relaying the catalog
 * changes who asks for the list, not what is believed about it.
 *
 * `unavailable` is its own answer rather than an empty `ok`, so a server that could not be
 * reached is never read as one with nothing to offer.
 */
async function askServer(): Promise<RemoteCatalog> {
  const reply: unknown = await callOr(storeContract, 'catalog', undefined, UNAVAILABLE);
  if (!reply || typeof reply !== 'object') return UNAVAILABLE;

  const { status, entries } = reply as { status?: unknown; entries?: unknown };
  if (status === 'off') return { status: 'off' };
  if (status !== 'ok' || !Array.isArray(entries)) return UNAVAILABLE;

  const valid: CatalogEntry[] = [];
  for (const row of entries as unknown[]) {
    if (isCatalogEntry(row)) {
      valid.push(row);
    } else {
      console.warn("micaOS Catalog: dropped a malformed entry from the server's catalog.", row);
    }
  }
  return { status: 'ok', entries: valid };
}

/**
 * A call already in flight is shared. Opening the Store asks for the listing and for the
 * update check in the same tick, and two relays there would be one answer fetched twice.
 * Cleared on settle, so the next visit asks again — the catalog moving underneath an
 * installed app is what the update check is for.
 */
let inflight: Promise<RemoteCatalog> | null = null;

export function fetchRemoteCatalog(): Promise<RemoteCatalog> {
  if (!inflight) {
    inflight = askServer().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
