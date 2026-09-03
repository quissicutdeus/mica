// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isTrustedRemoteUrl } from './remoteAppSecurity';
import {
  ALL_CAPABILITIES,
  ALL_PERMISSIONS,
  tileFromColorClasses,
  type AppCapability,
  type AppPermission,
  ALL_DEVICES,
  type AppDevice
} from './manifest';

/**
 * One installable app as an operator's catalog server describes it — everything
 * `installFromCatalog` needs to build the manifest itself, without ever running the
 * bundle to ask it. See `registry.ts`'s `installVerified`: the manifest is built from
 * these fields, never from `import()`ing fetched code.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  bundleUrl: string;
  /** Lowercase hex SHA-256 of the exact bytes at `bundleUrl`. Required — `installFromCatalog` refuses to import a bundle without one. */
  sha256: string;
  color: string;
  icon?: string;
  /** What this app discloses it reaches for — shown to a player before they install it. */
  permissions: AppPermission[];
  /**
   * Server capabilities the app cannot work without. See `AppManifest.requires`.
   *
   * A catalog entry is the *only* thing `installVerified` builds a remote manifest from —
   * it never `import()`s the fetched bundle to ask what it claims to be — so a capability
   * absent here is a capability the app can never declare, however plainly its own source
   * says otherwise. Optional, and absent means "needs none", which is both the right
   * default and the only thing a catalog written before this field existed can say.
   */
  requires?: AppCapability[];
  /**
   * MICA-260: the devices the app appears on. See `AppManifest.devices`. Here for the
   * reason `requires` is; absent means the phone, which is what every catalog written
   * before the field existed says.
   */
  devices?: readonly AppDevice[];
  /** Whether the phone should block this app while signal is out. Defaults to `false`. */
  requiresNetwork?: boolean;
  /** MICA-24: the exact origins the installed add-on's frame may `fetch()`. See `AppManifest.networkHosts`. */
  networkHosts?: readonly string[];
  /**
   * MICA-196: the server services this app owns. See `AppManifest.services`.
   *
   * Here for the same reason `requires` is: `installVerified` builds the installed
   * manifest from this entry and nothing else, never by running the fetched bundle to ask
   * what it claims to be, so a field absent here is one the installed app can never
   * declare. Absent means "did not say", and the old prefix rule answers for it — which is
   * what every catalog written before this field existed says, and the right thing for it
   * to mean.
   */
  services?: readonly string[];
  /**
   * MICA-196: the SDK contract version the bundle was compiled against. See
   * `AppManifest.sdkContract`.
   *
   * Here rather than read out of the fetched bundle for the reason every other field is:
   * `installVerified` never runs the code to ask it what it is. Absent means "did not say"
   * and installs exactly as it did before.
   */
  sdkContract?: string;
}

/**
 * The operator's catalog server, if they have one. Unset by default, so a server that has
 * not configured one sees exactly the bundled add-ons it saw before any of this shipped.
 *
 * It lives here rather than as a `const` inside the Store app, where it started, because
 * two things need the same answer now: the Store's own listing, and `appUpdates.ts`, which
 * has to check for a newer version at phone-open — before the Store has ever been opened,
 * and therefore before any constant inside it has been evaluated. Two copies of the URL
 * would be two things to configure, and a stale one would mean the Store listed a catalog
 * the update check never looked at.
 *
 * Settable rather than a literal for the same reason `setTrustedRemoteAppHosts` is: an
 * operator configures this at boot, and until they do it is honestly empty.
 */
let remoteCatalogUrl: string | undefined;

/** Point the Store and the update check at an operator's catalog. Both read the one value. */
export function setRemoteCatalogUrl(url: string | undefined): void {
  remoteCatalogUrl = url || undefined;
}

export function getRemoteCatalogUrl(): string | undefined {
  return remoteCatalogUrl;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Whether `value` has every field `CatalogEntry` requires, with the right primitive types. */
export function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.name) &&
    isNonEmptyString(v.version) &&
    isNonEmptyString(v.description) &&
    isNonEmptyString(v.bundleUrl) &&
    isNonEmptyString(v.sha256) &&
    // Not merely a non-empty string: a catalog is remote data, and a `color` that names no
    // `bg-` class is interpolated into a `class` attribute and renders an invisible tile.
    // Checked here so the row is dropped and logged rather than listed and unreadable.
    isNonEmptyString(v.color) &&
    tileFromColorClasses(v.color) !== null &&
    (v.icon === undefined || typeof v.icon === 'string') &&
    Array.isArray(v.permissions) &&
    v.permissions.every((p) => ALL_PERMISSIONS.includes(p as AppPermission)) &&
    // Checked against the vocabulary rather than merely typed, for the reason `defineApp`
    // throws on the same mistake: an unknown capability can never be satisfied by any
    // server, so the row would list an app that is refused everywhere with nothing said.
    // Dropping and logging the entry names the catalog that got it wrong.
    (v.requires === undefined ||
      (Array.isArray(v.requires) &&
        v.requires.every((c) => (ALL_CAPABILITIES as readonly string[]).includes(c as string)))) &&
    // Non-empty as well as known, for the reason `defineApp` refuses `[]`: a row that
    // lists no device is an app shown nowhere, and `installVerified` would throw on it.
    (v.devices === undefined ||
      (Array.isArray(v.devices) &&
        v.devices.length > 0 &&
        v.devices.every((d) => (ALL_DEVICES as readonly string[]).includes(d as string)))) &&
    (v.requiresNetwork === undefined || typeof v.requiresNetwork === 'boolean') &&
    (v.networkHosts === undefined ||
      (Array.isArray(v.networkHosts) && v.networkHosts.every((h) => typeof h === 'string'))) &&
    // Shape only. Whether these are ids this app may actually own is `defineApp`'s
    // question (the namespace) and the registry's (a collision with an installed app),
    // both of which need the id and the installed set that this predicate does not have.
    (v.services === undefined ||
      (Array.isArray(v.services) && v.services.every((s) => typeof s === 'string'))) &&
    // Shape only, again. Whether it *matches* this phone's contract is the registry's
    // question at install and the host server's at hydrate; dropping the row here would
    // hide an otherwise installable app behind a silent catalog warning.
    (v.sdkContract === undefined || typeof v.sdkContract === 'string')
  );
}

/**
 * Fetch and validate a catalog. `catalogUrl` must itself be on the trusted-host allowlist —
 * the same gate `installFromCatalog` applies to each entry's `bundleUrl` — so an operator
 * configures one allowlist, not two.
 *
 * An entry that fails validation is dropped and logged rather than failing the whole
 * catalog: one malformed row should not take down every other app on offer.
 */
export async function fetchCatalog(catalogUrl: string): Promise<CatalogEntry[]> {
  if (!isTrustedRemoteUrl(catalogUrl)) {
    throw new Error(`gPhone Catalog error: '${catalogUrl}' is not on the trusted host allowlist.`);
  }

  const response = await fetch(catalogUrl);
  if (!response.ok) {
    throw new Error(`gPhone Catalog error: HTTP ${response.status} fetching '${catalogUrl}'.`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`gPhone Catalog error: '${catalogUrl}' did not return a JSON array.`);
  }

  const entries: CatalogEntry[] = [];
  for (const row of body as unknown[]) {
    if (isCatalogEntry(row)) {
      entries.push(row);
    } else {
      console.warn(`gPhone Catalog: dropped a malformed entry from '${catalogUrl}'.`, row);
    }
  }
  return entries;
}
