// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a server's Store finds remote add-ons, decided once for both halves (MICA-237).
 *
 * `mica_addon_catalog` and `mica_addon_hosts` are read by the client, which hands the phone
 * its host allowlist, and by the server, which fetches the catalog on the phones' behalf.
 * Both must reach the same answer from the same two strings, so the rules live here and each
 * side only reads its convars and calls `resolveAddonConfig`.
 *
 * **A stock server now points at the project's public catalog** rather than at nothing: an
 * empty Store reads as "there is no ecosystem". The default is keyed by the phone's SDK
 * contract, not by release: a remote add-on has no server half (server code has to be
 * installed on the server), so the one thing it must match is the contract the shell already
 * enforces at install. The catalog lists only add-ons this resource does not already ship,
 * so the default never replaces a bundled app with a remote copy.
 *
 * Three states:
 *
 * - **default** — `mica_addon_catalog` was never set. The public catalog, and its host
 *   allowed alongside any hosts the operator listed.
 * - **custom** — set to a URL. That catalog, and exactly the hosts the operator listed; the
 *   catalog's own host must be among them, as before (`catalogWarning` says so).
 * - **off** — set to `off`, or set explicitly to an empty string. No catalog and no hosts,
 *   so no remote add-on installs or survives rehydration.
 *
 * Telling "never set" from "set to empty" needs a default `GetConvar` can hand back that no
 * operator would type: `CONVAR_UNSET`. Each caller passes it as the default, and passes the
 * raw result straight in.
 */

/** The host the project's public catalog and its bundles are served from. */
export const PUBLIC_ADDON_HOST = 'mica.gg';

/** The public catalog for one SDK contract version. */
export const publicAddonCatalogUrl = (sdkContract: string): string =>
  `https://${PUBLIC_ADDON_HOST}/addons/sdk-${sdkContract}/catalog.json`;

/**
 * What a caller passes to `GetConvar` as the default, so an unset convar is recognisable.
 *
 * Printable on purpose. FiveM hands a native its string arguments as NUL-terminated C
 * strings, so a sentinel starting with `\0` arrives as `''` — and `''` means `off`, which
 * would have turned every stock server's catalog off in game while every suite, stubbing
 * `GetConvar` in JavaScript, stayed green. `shared/addonConfig.test.ts` holds it printable.
 */
export const CONVAR_UNSET = '__mica_convar_unset__';

export type AddonCatalogState = 'default' | 'custom' | 'off';

export interface AddonCatalogSetting {
  state: AddonCatalogState;
  /** The catalog to fetch, or `''` when `state` is `off`. */
  catalogUrl: string;
  /** Hostnames a catalog or bundle may be fetched from, lowercased and de-duplicated. */
  hosts: string[];
}

/**
 * The hostname in an allowlist entry. A full URL is accepted and reduced, since an operator
 * writing this line has their catalog URL in front of them and pasting it is the obvious
 * mistake. Reduced by hand rather than with `new URL()`, which the FiveM client runtime is not
 * guaranteed to expose.
 */
export const hostnameOf = (value: string): string =>
  value
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split(/[/?#]/, 1)[0]
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();

/** An operator's allowlist, split on commas and whitespace, reduced to hostnames. */
export const parseTrustedHosts = (raw: string): string[] => {
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const host = hostnameOf(token.trim());
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
};

/** Resolve both convars' raw values, `CONVAR_UNSET` included, into what the Store uses. */
export const resolveAddonConfig = (
  rawCatalog: string,
  rawHosts: string,
  sdkContract: string
): AddonCatalogSetting => {
  const listed = rawHosts === CONVAR_UNSET ? [] : parseTrustedHosts(rawHosts);

  if (rawCatalog === CONVAR_UNSET) {
    const hosts = listed.includes(PUBLIC_ADDON_HOST) ? listed : [PUBLIC_ADDON_HOST, ...listed];
    return { state: 'default', catalogUrl: publicAddonCatalogUrl(sdkContract), hosts };
  }

  const catalog = rawCatalog.trim();
  if (catalog === '' || catalog.toLowerCase() === 'off') {
    return { state: 'off', catalogUrl: '', hosts: [] };
  }

  return { state: 'custom', catalogUrl: catalog, hosts: listed };
};
