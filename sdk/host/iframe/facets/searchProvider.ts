// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets, ProvidedHit } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['searchProvider']>>;

/**
 * The iframe twin of the `searchProvider` facet (MICA-286).
 *
 * Two members, one in each direction the seam already goes: `query` is a pushed store, and
 * `publish` is an ordinary call out. Nothing has to be added to the transport for an
 * add-on to contribute search results, which is the whole reason the facet is shaped this
 * way round — the shell cannot call into a frame, so the frame answers a question it was
 * pushed.
 *
 * The app's rows never appear on the wire. `search` runs in here, against whatever this
 * bundle already holds, and only the hits it returned are sent.
 */
export function searchProvider(appId: string): Twin {
  const factoryArgs = [appId];
  return {
    query: store('searchProvider', factoryArgs, 'query', ''),
    // Returns a promise the caller has no reason to await: the shell answers it with
    // nothing, and a hit list is worth exactly as much whether or not the frame hears that
    // it landed. Assignable to the contract's `void` return, like `lifecycle.goHome`.
    publish: (needle: string, hits: readonly ProvidedHit[]) =>
      fn<(n: string, h: readonly ProvidedHit[]) => Promise<void>>(
        'searchProvider',
        factoryArgs,
        'publish'
      )(needle, hits)
  };
}

// No `as unknown as Facets[...]` here, unlike most twins: this facet was designed for the
// seam, so what the frame can honestly offer (MICA-26) is exactly what the contract says —
// a `Readable` the shell pushes and a call out — and the registration typechecks as it
// stands. The day a member of it needs bridging, that is the line to change.
registerFacet('searchProvider', searchProvider);
