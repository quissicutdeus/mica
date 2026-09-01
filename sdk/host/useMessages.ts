// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';
import { facets } from './current';
import { lazyBadge } from '../lazyBadge';

/**
 * MICA-176: the launcher badge count, read through the facet registry rather than
 * re-exported from `./inProcess/facets/messages`. That re-export was a *value* edge across
 * the host seam — `facetSwap()` in `vite.addon.config.ts` rewrote the specifier for an
 * add-on build, so the same source line named two different stores and only a resolver
 * plugin decided which. `unreadMessagesCount` is already a member of the `messages` facet on both
 * sides, so the registry answers it with no new facet name and no permission-table row.
 *
 * `facets.messages()`, not `useMessages()`: this export has never been permission-gated
 * (it is read at app-registration time, before any host exists) and gating it here would be
 * a behaviour change wearing a refactor's commit message. The shell re-checks the wire call
 * behind the store either way (AGENTS.md §7).
 *
 * `lazyBadge` because the composition has to wait for the facet set to be registered:
 * `shell/state/registry.ts` globs every manifest at the earliest moment in the phone's
 * life, and a manifest naming this at module scope would otherwise read the registry before
 * the entry point had filled it.
 */
export const unreadMessagesCount = lazyBadge(() => facets.messages().unreadMessagesCount);

/**
 * OS Service Hook for accessing SMS messaging.
 */
export function useMessages() {
  return guarded('useMessages').facets.messages();
}
