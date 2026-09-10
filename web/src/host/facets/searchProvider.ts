// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import type { ProvidedHit } from '../../../../sdk/host/facets';
import { publishSearchHits, searchNeedle } from '../../shell/state/searchProviders';

/**
 * Implementation of the `useSearchProvider` facet (MICA-286) — see the hook's doc for the
 * usage contract, and `shell/state/searchProviders.ts` for what the shell does with what
 * is published.
 *
 * `appId` is a factory argument rather than an argument to `publish`, so the id an app
 * publishes under is fixed when the facet is constructed. That is what
 * `IframeHostServer.ts`'s `APP_SCOPED_FACETS` pins for a sandboxed frame: with the id on
 * `publish` instead, a pinned factory argument would prove nothing about the id on the
 * call.
 */
export function searchProvider(appId: string) {
  return {
    query: searchNeedle,
    publish: (needle: string, hits: readonly ProvidedHit[]): void =>
      publishSearchHits(appId, needle, hits)
  };
}

registerFacet('searchProvider', searchProvider);
