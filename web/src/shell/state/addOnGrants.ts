// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { ALL_PERMISSIONS, type AppPermission } from '../../../../sdk/manifest';

/**
 * What the player actually agreed to give each add-on — shell-owned (MICA-201).
 *
 * MICA-196 made the Store compare an update's permissions against the installed
 * manifest and re-prompt when the list grew. That record lived in the Store, which is an
 * app: the installed manifest *was* the consent, and the shell held nothing of its own.
 * So anything that could write an installed manifest — a modified Store, a bug in the
 * catalog install path, a future core screen — widened what an add-on may reach with
 * nobody asked, and every layer downstream would have read the widened manifest as
 * consent because there was nothing else to read.
 *
 * This is the something else. A grant is written **only** through `appRegistryWrite`'s
 * `recordConsent`, which no add-on can name (`FACET_MEMBERS.appRegistryWrite` is empty,
 * so a raw `postMessage` gets "core only"), and it is read by `IframeHostServer` before
 * it answers any call: a permission on the manifest with no matching grant is refused
 * exactly as an undeclared one is, so an update that adds a permission is dead until the
 * grant is widened by a player answering the Store's prompt.
 *
 * ## Where it lives, and why
 *
 * `usePersisted('shell', 'addOnGrants', …)` — the same `gphone_settings` storage the
 * install list itself rides (`registry.ts`'s `installedAddOnIds`), so a grant follows the
 * character exactly as the install does, survives a character switch through
 * `usePersisted`'s own rehydrate, and needs no schema change. Server-side beside
 * `gphone_app_registry` would survive the same switch and would cost a table plus a
 * migration to hold a fact the shell already knows how to persist per character.
 *
 * Namespaced under `'shell'`, not `'store'`: the whole point is that the record is not
 * the Store's. `'shell'` is not an app id, so `unregisterApp`/`clearAppStorage` can never
 * target this namespace even if an add-on somehow reached them.
 *
 * ## Its limits, stated plainly
 *
 * This is storage the shell owns, not storage the shell can prove untampered. A player
 * with the console open can edit any persisted value here, as they can edit the install
 * list next to it. What it stops is a *code* path — the Store or anything else writing a
 * manifest — silently standing in for a player's answer.
 */

const PERMISSIONS = new Set<string>(ALL_PERMISSIONS);

/** Drop anything that is not a real permission, and any id that maps to no list. */
const sanitizeGrants = (value: unknown): Record<string, AppPermission[]> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, AppPermission[]> = {};
  for (const [appId, perms] of Object.entries(value as Record<string, unknown>)) {
    if (!appId || !Array.isArray(perms)) continue;
    out[appId] = [
      ...new Set(
        perms.filter((p): p is AppPermission => typeof p === 'string' && PERMISSIONS.has(p))
      )
    ];
  }
  return out;
};

const grants = usePersisted<Record<string, AppPermission[]>>(
  'shell',
  'addOnGrants',
  {},
  {
    sanitize: sanitizeGrants
  }
);

/**
 * What the player granted this add-on, or `undefined` when they were never asked.
 *
 * `undefined` and `[]` are different answers and both are refusals at the host: an app
 * with no grant at all reaches nothing that needs a permission, same as one granted the
 * empty set. They are kept distinct so `adoptExistingGrant` can tell an install that
 * predates this record from one whose player genuinely accepted nothing.
 */
export function grantedPermissions(appId: string): AppPermission[] | undefined {
  return get(grants)[appId];
}

/**
 * Record the set a player just accepted, replacing whatever stood before.
 *
 * Replacing rather than merging: an update that *drops* a permission must narrow the
 * grant, or an add-on could regain a capability by republishing without it and then
 * asking again later against a grant nobody ever revoked.
 */
export function recordConsent(appId: string, permissions: readonly AppPermission[]): void {
  const accepted = [...new Set(permissions.filter((p) => PERMISSIONS.has(p)))];
  grants.update((all) => ({ ...all, [appId]: accepted }));
}

/** Forget an add-on's grant. Called by `unregisterApp`: uninstalling is withdrawing consent. */
export function revokeConsent(appId: string): void {
  grants.update((all) => {
    if (!(appId in all)) return all;
    const next = { ...all };
    delete next[appId];
    return next;
  });
}

/**
 * The one-time migration for an add-on installed before this record existed.
 *
 * Such an install has a manifest whose permissions a player *was* shown and did accept —
 * the Store has listed them beside the Install button since long before MICA-196 — but
 * no grant, and refusing it outright would break every already-installed add-on on the
 * first boot after this ships. So a *missing* record is adopted from the installed
 * manifest once, at re-registration, and from then on the grant is the record: a later
 * update that widens the manifest is refused until the player answers, which is the
 * behaviour this ticket is for.
 *
 * Deliberately no-ops when a grant already exists, including an empty one. That is what
 * keeps it a migration rather than a back door — nothing can call this to re-widen a
 * grant a player narrowed.
 */
export function adoptExistingGrant(appId: string, permissions: readonly AppPermission[]): void {
  if (grantedPermissions(appId) !== undefined) return;
  recordConsent(appId, permissions);
}

/** Test seam: drop every grant. */
export function resetGrantsForTest(): void {
  grants.set({});
}
