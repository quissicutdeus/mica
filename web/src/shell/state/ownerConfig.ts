// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, writable } from 'svelte/store';
import type { OwnerConfig } from '@mica/shared/ownerConfig';

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
