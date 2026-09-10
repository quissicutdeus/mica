// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, writable } from 'svelte/store';
import type { OwnerConfig } from '@mica/shared/ownerConfig';
import { callOr } from '../../nui/call';
import { shellContract } from '@mica/shared/contracts/shell';

/**
 * The server owner's phone configuration (MICA-234), answered once by `shell:ownerConfig`.
 *
 * Until that answer arrives nothing is disabled and the dock is the built-in one, so a slow
 * or failed round trip leaves the phone exactly as it was before the convars existed. The
 * server refuses a disabled app's events regardless; hiding it here is the player-facing half.
 */
export const ownerConfig = writable<OwnerConfig>({ disabledApps: [], defaultDock: [] });

/** The disabled app ids, as a set for the launcher, drawer, search, Store and SDK host. */
export const disabledAppIds = derived(
  ownerConfig,
  ($c): ReadonlySet<string> => new Set($c.disabledApps)
);

const DEFAULT_OWNER_CONFIG: OwnerConfig = { disabledApps: [], defaultDock: [] };

/**
 * Ask the server for the owner's configuration, the way `refreshLocale` asks for
 * `shell:locale` — quiet, because it may run before a character has loaded, and defaulted
 * rather than thrown, so a slow or failed round trip leaves `ownerConfig` at the defaults
 * it already started with.
 */
export async function refreshOwnerConfig(): Promise<void> {
  const reply = await callOr(shellContract, 'ownerConfig', undefined, DEFAULT_OWNER_CONFIG, {
    quiet: true
  });
  ownerConfig.set(reply);
}
