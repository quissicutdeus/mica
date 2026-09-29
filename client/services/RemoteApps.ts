// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The client half of remote add-on configuration.

import type { RemoteAppConfigPayload } from '@mica/shared/nui';
import {
  CONVAR_UNSET,
  hostnameOf,
  resolveAddonConfig,
  type AddonCatalogSetting
} from '@mica/shared/addonConfig';
import { SDK_CONTRACT_VERSION } from '../../sdk/version';

/**
 * The two convars that decide where the Store finds add-ons and whose code it may run.
 *
 * `web/src/shell/state/remoteAppSecurity.ts` holds a host allowlist and
 * `web/src/shell/state/catalog.ts` holds a catalog URL; this file is where the phone gets
 * both. What the two strings mean — the public catalog when the catalog convar was never
 * set, the operator's own when it names one, nothing at all when it is `off` or set to empty
 * — is decided in `shared/addonConfig.ts`, once, because the server reads the same two
 * convars to fetch the catalog on the phones' behalf and must reach the same answer
 * (MICA-237). This file only reads them.
 *
 * Both need `setr`. The values are consumed by the phone's own UI, which cannot read a
 * convar at all, and a plain `set` never leaves the server — the same reason
 * `mica_camera_quality` and `mica_music_range` are replicated (README).
 *
 * Both names are spelled out at each `GetConvar` call below rather than read from the
 * constants beside them. `server/__tests__/convars.test.ts` scans this source for the
 * literal a convar is read by, and holds the README to it; a name reached through a
 * variable is a name that scan cannot resolve, which is the one thing it fails on.
 *
 * `CONVAR_UNSET` is the default at both calls so "never set" and "set to empty" stay
 * distinguishable: the first is the public catalog, the second is an operator opting out.
 */
const HOSTS_CONVAR = 'mica_addon_hosts';
const CATALOG_CONVAR = 'mica_addon_catalog';

const hasConvars = (): boolean => typeof GetConvar === 'function';

/**
 * The resolved setting, state included.
 *
 * Read on every call rather than cached at resource start, so an operator who fixes a typo
 * with `setr` from the live console reaches a player the next time their phone boots the
 * NUI page — the same "read on every use" property most of the convars in the README have.
 *
 * With no `GetConvar` at all the answer is `off`, not the default: a runtime that cannot
 * say what the operator configured must not assume they wanted the public catalog.
 */
export const addonSetting = (): AddonCatalogSetting => {
  if (!hasConvars()) return { state: 'off', catalogUrl: '', hosts: [] };
  return resolveAddonConfig(
    GetConvar('mica_addon_catalog', CONVAR_UNSET) ?? CONVAR_UNSET,
    GetConvar('mica_addon_hosts', CONVAR_UNSET) ?? CONVAR_UNSET,
    SDK_CONTRACT_VERSION
  );
};

/** What the phone is handed: the allowlist and the catalog, `''` when the Store is off. */
export const remoteAppConfig = (): RemoteAppConfigPayload => {
  const { hosts, catalogUrl } = addonSetting();
  return { hosts, catalogUrl };
};

/**
 * Say so, loudly, when an operator's own catalog cannot load.
 *
 * Only a `custom` catalog can be wrong this way. The default's host is put on the allowlist
 * by construction, and `off` has nothing to load.
 *
 * `fetchCatalog` holds the catalog URL to the same allowlist as every `bundleUrl`, so an
 * operator configures one list rather than two. The failure mode that costs an evening is
 * setting `mica_addon_catalog` and forgetting `mica_addon_hosts`: the Store then lists
 * nothing, with the explanation buried in a CEF console the operator has no reason to open.
 * A check that stays silent when it cannot pass reads as a pass, so this one prints.
 */
export const catalogWarning = (setting: AddonCatalogSetting): string | null => {
  if (setting.state !== 'custom') return null;

  if (!/^https:\/\//i.test(setting.catalogUrl)) {
    return (
      `${CATALOG_CONVAR} must be an https:// URL ('${setting.catalogUrl}'); ` +
      'no add-on catalog will load.'
    );
  }

  const host = hostnameOf(setting.catalogUrl);
  if (!host) {
    return `${CATALOG_CONVAR} has no hostname ('${setting.catalogUrl}'); no add-on catalog will load.`;
  }
  if (!setting.hosts.includes(host)) {
    return (
      `${CATALOG_CONVAR} points at '${host}', which is not in ${HOSTS_CONVAR}. ` +
      'Add it there, or the catalog and every bundle on it will be refused.'
    );
  }

  return null;
};

/**
 * The one line an operator reads to learn which catalog is in force, rather than finding
 * out from an empty or unexpectedly full Store.
 */
export const catalogStateLine = (setting: AddonCatalogSetting): string =>
  setting.state === 'off'
    ? `add-on catalog (${CATALOG_CONVAR}) off`
    : `add-on catalog (${CATALOG_CONVAR}) ${setting.state}: ${setting.catalogUrl}`;

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
 * awaits answers that question exactly. `mica_camera_quality` is the existing precedent —
 * a convar the UI needs, handed over on request rather than broadcast.
 */
RegisterNuiCallbackType('remoteAppConfig');
on('__cfx_nui:remoteAppConfig', (_: any, cb: Function) => {
  cb(remoteAppConfig());
});

const startupSetting = addonSetting();
console.log(`[micaOS] ${catalogStateLine(startupSetting)}`);
const startupWarning = catalogWarning(startupSetting);
if (startupWarning) console.warn(`[micaOS] ${startupWarning}`);
