// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseRemoteAppConfig, type RemoteAppConfigPayload } from '@gos/shared/nui';
import { fetchNui } from '../../nui/fetchNui';
import { setRemoteCatalogUrl } from '../../../../sdk/catalog';
import { appRegistryStore } from './registry';
import { setTrustedRemoteAppHosts } from '../../../../sdk/remoteAppSecurity';

/**
 * The one thing that ever fills the remote add-on trust boundary in a shipped build.
 *
 * `setTrustedRemoteAppHosts` and `setRemoteCatalogUrl` existed, were tested, were exported
 * from `@gos/sdk` — and had no caller outside a unit test (MICA-126). With an empty
 * allowlist `isTrustedRemoteUrl` answers `false` for every `https:` URL, so the whole
 * catalog path ended at its first check on every build anybody has ever run. This asks the
 * game client for the operator's two convars and applies them.
 *
 * **Empty is the expected answer.** A server that configures neither convar gets exactly
 * the behaviour it had before this file existed: the Store lists bundled add-ons only, and
 * nothing remote installs. That is not a degraded mode to apologise for — turning it on
 * means telling a host it may ship JavaScript into your players' phones, and nobody should
 * be opted into that by a default.
 */
const NO_CONFIG: RemoteAppConfigPayload = { hosts: [], catalogUrl: '' };

/**
 * Ask the client, apply, and only then let the registry re-verify what is installed.
 *
 * The ordering is the whole reason this is a function rather than two setters at a call
 * site. `registry.ts` re-fetches and re-hashes every saved remote install at boot, and that
 * runs through `isTrustedRemoteUrl` — so with the allowlist still empty it can only refuse
 * everything. It now returns quietly in that state instead, and this is what runs it for
 * real once there is an allowlist to judge against. Skip the `await` here and a player who
 * installed an add-on last session finds it gone this one.
 *
 * `defaultValue` rather than a throw: a transport failure has to leave the phone in the
 * configured-nothing state, which is the safe direction. Idempotent, so calling it twice
 * costs one extra round trip and changes nothing.
 */
export async function loadRemoteAppConfig(): Promise<RemoteAppConfigPayload> {
  const reply = await fetchNui<unknown>(
    'remoteAppConfig',
    {},
    { defaultValue: NO_CONFIG, quiet: true }
  );

  const applied = parseRemoteAppConfig(reply) ?? NO_CONFIG;

  setTrustedRemoteAppHosts(applied.hosts);
  setRemoteCatalogUrl(applied.catalogUrl || undefined);

  if (applied.hosts.length > 0) {
    await appRegistryStore.rehydrateSavedRemoteApps();
  }

  return applied;
}
