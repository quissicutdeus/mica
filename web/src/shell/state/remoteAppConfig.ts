// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseRemoteAppConfig, type RemoteAppConfigPayload } from '@mica/shared/nui';
import { fetchNui } from '../../nui/fetchNui';
import { setRemoteCatalogUrl } from '../../../../sdk/catalog';
import { appRegistryStore } from './registry';
import { setTrustedRemoteAppHosts } from '../../../../sdk/remoteAppSecurity';

/**
 * The one thing that ever fills the remote add-on trust boundary in a shipped build.
 *
 * `setTrustedRemoteAppHosts` and `setRemoteCatalogUrl` existed, were tested, were exported
 * from `@mica/sdk` — and had no caller outside a unit test (MICA-126). With an empty
 * allowlist `isTrustedRemoteUrl` answers `false` for every `https:` URL, so the whole
 * catalog path ended at its first check on every build anybody has ever run. This asks the
 * game client for the operator's two convars and applies them.
 *
 * **Empty means `off`.** A server that sets `mica_addon_catalog off` gets exactly the
 * behaviour it had before this file existed: the Store lists bundled add-ons only, and
 * nothing remote installs or rehydrates. A server that sets neither convar gets the
 * project's public catalog and `mica.gg` on the allowlist (MICA-237): an allowed host may
 * ship JavaScript into your players' phones, which is why every bundle is hash-pinned in
 * its catalog entry and runs in the sandbox, and why `off` exists.
 */
const NO_CONFIG: RemoteAppConfigPayload = { hosts: [], catalogUrl: '' };

/** The first retry after a failed ask, doubling to `RETRY_MAX_MS` while it keeps failing. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/** The last configuration the client actually answered with, once there is one. */
let answered: RemoteAppConfigPayload | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_FIRST_MS;

const apply = (config: RemoteAppConfigPayload) => {
  setTrustedRemoteAppHosts(config.hosts);
  setRemoteCatalogUrl(config.catalogUrl || undefined);
};

/** Ask again later, backing off. One pending retry at most; a direct call supersedes it. */
const scheduleRetry = () => {
  if (retryTimer) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void loadRemoteAppConfig();
  }, delay);
};

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
 * **A failure fails closed, and is asked again.** A transport failure, or a reply that is not
 * a configuration, leaves the phone configured-nothing — no host trusted, nothing remote
 * installs — which is the safe direction. It used to stop there: this was asked once, at
 * `Shell.svelte`'s mount, so a failure at resource start (the client's callback not yet
 * registered) kept every saved add-on off the launcher for the whole session. It now retries
 * on a backoff until the client answers, and the answer rehydrates saved installs as the
 * first one would have. A configuration already applied is kept through a later failure:
 * the convars are the operator's, and a failed re-ask has learned nothing about them.
 *
 * Resolves after the first attempt either way, so the caller is never held behind a retry.
 * Idempotent, so calling it twice costs one extra round trip and changes nothing.
 */
export async function loadRemoteAppConfig(): Promise<RemoteAppConfigPayload> {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  let config: RemoteAppConfigPayload | null;
  try {
    config = parseRemoteAppConfig(await fetchNui<unknown>('remoteAppConfig', {}));
  } catch {
    config = null;
  }

  if (!config) {
    scheduleRetry();
    if (answered) return answered;
    apply(NO_CONFIG);
    return NO_CONFIG;
  }

  answered = config;
  retryDelay = RETRY_FIRST_MS;
  apply(config);

  if (config.hosts.length > 0) {
    await appRegistryStore.rehydrateSavedRemoteApps();
  }

  return config;
}
