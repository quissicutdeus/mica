import { derived, get, writable, type Readable } from 'svelte/store';
import { compareVersions } from '../../lib/phone/semver';
import { fetchCatalog, getRemoteCatalogUrl, type CatalogEntry } from '../../sdk/catalog';
import { appRegistryStore } from './registry';
import type { AppManifest } from '../../sdk/manifest';
import { messageOf } from '@gphone/sdk';

/**
 * Whether an installed add-on has fallen behind the catalog.
 *
 * Both halves of the comparison already existed and nothing put them together: a catalog
 * entry carries a `version` (`catalog.ts`), and `installVerified` copies that string onto
 * the installed manifest. A player therefore had no way to learn that a newer bundle had
 * been published — which matters beyond features, because the `sha256`/CSP/`networkHosts`
 * hardening around add-ons assumes a fixed vulnerability can actually reach the people
 * running the broken copy.
 *
 * Only a **catalog install** (`isRemote`) can be behind. A bundled add-on's code is part of
 * this build — its version is the phone's own, and there is nowhere newer to get it from.
 */
export type AppUpdateKind =
  /** The catalog's version is strictly newer than what is installed. */
  | 'newer'
  /**
   * The two versions differ and cannot be ordered — one of them is not a version this can
   * parse (`lib/semver.ts`). Surfaced rather than swallowed: an operator who publishes
   * `nightly` still republished *something*, and silently calling that "up to date" is the
   * failure this ticket is about. It is shown as a mismatch, never as "newer".
   */
  | 'unordered';

export interface AppUpdate {
  appId: string;
  /** The installed app's name, so a caller can say what is out of date without a second lookup. */
  name: string;
  installedVersion: string | undefined;
  availableVersion: string;
  kind: AppUpdateKind;
  /** The catalog entry to install. Carries the fresh `sha256`, so the update re-verifies like any install. */
  entry: CatalogEntry;
}

/**
 * The last catalog `refreshAppUpdates` fetched. Empty until something asks, and left alone
 * by a failed fetch — see `refreshAppUpdates`.
 */
const catalogSnapshot = writable<CatalogEntry[]>([]);

/** Pure, so the comparison is testable without a network or a registry. */
export function computeAppUpdates(
  installed: readonly AppManifest[],
  entries: readonly CatalogEntry[]
): AppUpdate[] {
  const updates: AppUpdate[] = [];

  for (const app of installed) {
    // A bundled add-on ships inside this build; only a catalog install has a published
    // copy that can move ahead of it.
    if (!app.isRemote) continue;

    const entry = entries.find((e) => e.id === app.id);
    if (!entry) continue;

    const order = compareVersions(entry.version, app.version);
    if (order === 1) {
      updates.push({
        appId: app.id,
        name: app.name,
        installedVersion: app.version,
        availableVersion: entry.version,
        kind: 'newer',
        entry
      });
      continue;
    }
    if (order !== null) continue; // equal, or the catalog is behind — nothing to offer.

    // Unorderable. Identical text is still the same build even when neither side parses,
    // so only a genuine difference is worth telling anyone about.
    if (app.version?.trim() === entry.version.trim()) continue;
    updates.push({
      appId: app.id,
      name: app.name,
      installedVersion: app.version,
      availableVersion: entry.version,
      kind: 'unordered',
      entry
    });
  }

  return updates;
}

/**
 * Derived from the registry and the last fetched catalog rather than assembled by hand, so
 * it cannot go stale behind an install: updating an app rewrites its manifest version, and
 * uninstalling one removes it from the registry — both recompute this without anyone having
 * to remember to prune a list.
 */
export const appUpdates: Readable<AppUpdate[]> = derived(
  [appRegistryStore, catalogSnapshot],
  ([$installed, $entries]) => computeAppUpdates($installed, $entries)
);

/**
 * What the Store's launcher badge counts.
 *
 * Both kinds, deliberately. The badge is "there is something here for you", and an
 * unorderable mismatch is exactly as actionable as a newer version — the rows themselves
 * are what distinguish the two, and only a `newer` row ever claims to be newer.
 */
export const appUpdateCount: Readable<number> = derived(appUpdates, ($updates) => $updates.length);

/**
 * Re-check the configured catalog.
 *
 * A failed fetch **keeps the previous answer** rather than clearing it. A catalog server
 * that is down is not evidence that anybody is up to date, and dropping a known-pending
 * update on a network blip is the same silent "you're fine" this exists to prevent. With no
 * catalog configured there is nothing to compare against and the list is emptied honestly.
 */
export async function refreshAppUpdates(): Promise<AppUpdate[]> {
  const catalogUrl = getRemoteCatalogUrl();
  if (!catalogUrl) {
    catalogSnapshot.set([]);
    return [];
  }

  try {
    catalogSnapshot.set(await fetchCatalog(catalogUrl));
  } catch (error) {
    console.warn(
      `gPhone Store: could not check '${catalogUrl}' for add-on updates:`,
      messageOf(error, 'unknown error')
    );
  }

  return get(appUpdates);
}

/**
 * Install the catalog's copy of an app that has an update pending.
 *
 * `installFromCatalog` and nothing else — the same path a first install takes, so the
 * bundle is re-fetched, re-hashed against the entry's `sha256` and refused on a mismatch.
 * A second update-shaped path would be a second place for that verification to be forgotten.
 *
 * Throws if nothing is pending for `appId`, which is what a stale button in a screen left
 * open looks like; `useAppAction` turns the message into a toast.
 */
export async function updateApp(appId: string): Promise<AppManifest> {
  const pending = get(appUpdates).find((update) => update.appId === appId);
  if (!pending) {
    throw new Error(`No update is available for '${appId}'.`);
  }

  const { manifest } = await appRegistryStore.installFromCatalog(pending.entry);
  return manifest;
}
