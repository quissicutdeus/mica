// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { GOS_SOURCE_URL } from '@gos/sdk';
import { callOr } from '../nui/call';
import { shellContract } from '@gos/shared/contracts/shell';

/**
 * Where this server says its source lives (MICA-192, AGPL §13).
 *
 * The default is upstream, and it is the honest answer for a server running an unmodified
 * copy — which is most of them. An operator running a fork sets `gos_source_url`, and
 * §13 is the reason they should: the obligation is theirs, and a phone pointing at this
 * repository tells their players something false about code they are actually running.
 *
 * A store rather than a fetch inside the pane, matching `capabilities.ts`: About is
 * resident once opened (AGENTS.md §11), so a value fetched on mount would be whatever it
 * was the first time the player ever looked.
 */
export const sourceUrl = writable<string>(GOS_SOURCE_URL);

/**
 * Ask the server, and keep the default if it does not answer.
 *
 * `fetchNui` returns its `defaultValue` when the callback is not registered — in a plain
 * browser, or against a server too old to know the action — so an absent answer leaves the
 * upstream address rather than an empty one. A notice with no address is a §13 offer that
 * cannot be acted on, which is worse than one naming the wrong repository.
 */
export async function refreshSourceUrl(): Promise<void> {
  const res = await callOr(shellContract, 'sourceUrl', undefined, { url: '' });
  const url = typeof res?.url === 'string' ? res.url.trim() : '';
  if (url) sourceUrl.set(url);
}
