// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The client half of remote add-on configuration.

import type { RemoteAppConfigPayload } from '@gos/shared/nui';

/**
 * The two convars that decide whether the Store can install anything at all.
 *
 * `web/src/shell/state/remoteAppSecurity.ts` holds a host allowlist and
 * `web/src/shell/state/catalog.ts` holds a catalog URL, and until MICA-126 nothing in a
 * shipped build ever set either: the whole remote add-on path — fetch, host check, pinned
 * SHA-256, sandboxed frame — was complete, tested, and unreachable, because
 * `isTrustedRemoteUrl` answers `false` for every URL while the allowlist is empty.
 *
 * **Both are empty by default and that is the feature, not an oversight.** Filling either
 * one is an operator saying "this host may ship JavaScript that runs inside my players'
 * phones". A server that sets neither behaves exactly as it did before this file existed,
 * which is why the defaults below are `''` rather than a gOS-operated catalog: there is
 * no such thing as a sensible default for whose code you trust.
 *
 * Both need `setr`. The values are consumed by the phone's own UI, which cannot read a
 * convar at all, and a plain `set` never leaves the server — the same reason
 * `gos_camera_quality` and `gos_music_range` are replicated (README).
 *
 * Both names are spelled out at each `GetConvar` call below rather than read from the
 * constants beside them. `server/__tests__/convars.test.ts` scans this source for the
 * literal a convar is read by, and holds the README to it; a name reached through a
 * variable is a name that scan cannot resolve, which is the one thing it fails on.
 */
const HOSTS_CONVAR = 'gos_addon_hosts';
const CATALOG_CONVAR = 'gos_addon_catalog';

const hasConvars = (): boolean => typeof GetConvar === 'function';

/**
 * Split an operator's allowlist into hostnames.
 *
 * Commas *and* whitespace, because a convar is a free-form string and both spellings turn
 * up in a `server.cfg`; a value that reads as a list to a human should read as one here.
 *
 * A bare hostname is what this wants (`store.example.com`), and a full URL is accepted and
 * reduced to its hostname rather than rejected. That leniency is not politeness: the value
 * an operator has in front of them while writing this line is their catalog URL, so pasting
 * it is the obvious mistake, and the failure it would otherwise cause — an allowlist entry
 * that can never match a hostname — is invisible until an install is refused with a message
 * about a host that looks, to them, like it is right there in the config.
 *
 * Lowercased and de-duplicated, since `isTrustedRemoteUrl` compares against a lowercased
 * `URL.hostname`. Reduced by hand rather than by `new URL()`, which the client's TypeScript
 * lib does not have and which the FiveM client runtime is not guaranteed to expose either —
 * the web half is the side with a real URL parser, and it is the side that matters, since
 * `isTrustedRemoteUrl` is what actually decides.
 */
export const hostnameOf = (value: string): string =>
  value
    // Scheme, if the operator pasted a whole URL.
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    // Path, query or fragment.
    .split(/[/?#]/, 1)[0]
    // `user:pass@` — never useful here, and it would otherwise become the "hostname".
    .replace(/^[^@]*@/, '')
    // Port. Bracketed IPv6 keeps its brackets, matching what `URL.hostname` reports.
    .replace(/:\d+$/, '')
    .toLowerCase();

export const parseTrustedHosts = (raw: string): string[] => {
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const host = hostnameOf(token.trim());
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
};

/** The catalog URL as the operator wrote it, or `''` for "no catalog configured". */
export const parseCatalogUrl = (raw: string): string => raw.trim();

/**
 * Both values, resolved from the convars.
 *
 * Read on every call rather than cached at resource start, so an operator who fixes a typo
 * with `setr` from the live console reaches a player the next time their phone boots the
 * NUI page — the same "read on every use" property most of the convars in the README have.
 */
export const remoteAppConfig = (): RemoteAppConfigPayload => {
  if (!hasConvars()) return { hosts: [], catalogUrl: '' };
  return {
    hosts: parseTrustedHosts(GetConvar('gos_addon_hosts', '') ?? ''),
    catalogUrl: parseCatalogUrl(GetConvar('gos_addon_catalog', '') ?? '')
  };
};

/**
 * Say so, loudly, when the catalog host is not allowlisted.
 *
 * `fetchCatalog` holds the catalog URL to the same allowlist as every `bundleUrl`, so an
 * operator configures one list rather than two. The failure mode that costs an evening is
 * setting `gos_addon_catalog` and forgetting `gos_addon_hosts`: the Store then lists
 * nothing, with the explanation buried in a CEF console the operator has no reason to open.
 * A check that stays silent when it cannot pass reads as a pass, so this one prints.
 */
export const catalogWarning = (config: RemoteAppConfigPayload): string | null => {
  if (!config.catalogUrl) return null;

  if (!/^https:\/\//i.test(config.catalogUrl)) {
    return (
      `${CATALOG_CONVAR} must be an https:// URL ('${config.catalogUrl}'); ` +
      'no add-on catalog will load.'
    );
  }

  const host = hostnameOf(config.catalogUrl);
  if (!host) {
    return `${CATALOG_CONVAR} has no hostname ('${config.catalogUrl}'); no add-on catalog will load.`;
  }
  if (!config.hosts.includes(host)) {
    return (
      `${CATALOG_CONVAR} points at '${host}', which is not in ${HOSTS_CONVAR}. ` +
      'Add it there, or the catalog and every bundle on it will be refused.'
    );
  }

  return null;
};

/**
 * A pull, not a push, and the difference matters here.
 *
 * `Signal.ts` and `Battery.ts` push their state into the NUI because it *changes* and the
 * phone has to be told. This does not change: it is configuration, read once when the page
 * boots. Pushing it would mean firing `SendNuiMessage` at resource start, racing the CEF
 * page's own load — a message posted before the shell attaches its `message` listener is
 * dropped, with nothing anywhere to say so.
 *
 * More importantly the shell has to *wait* for this. `registry.ts` re-verifies every saved
 * remote install at boot, and that check runs through the allowlist; with a push, the shell
 * could never know whether an allowlist was still coming or whether the operator had simply
 * configured none, so it could never decide when to give up and rehydrate. A reply it
 * awaits answers that question exactly. `gos_camera_quality` is the existing precedent —
 * a convar the UI needs, handed over on request rather than broadcast.
 */
RegisterNuiCallbackType('remoteAppConfig');
on('__cfx_nui:remoteAppConfig', (_: any, cb: Function) => {
  cb(remoteAppConfig());
});

const startupWarning = catalogWarning(remoteAppConfig());
if (startupWarning) console.warn(`[gOS] ${startupWarning}`);
