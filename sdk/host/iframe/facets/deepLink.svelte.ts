// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import { lifecycle } from './lifecycle';

/**
 * Implementation of the `useDeepLink` facet — see the inProcess twin for the usage
 * contract. A rune file rather than a plain module, like its inProcess counterpart: the
 * handler reads props and stores, and only an effect re-runs when those change.
 */
export function deepLink(appId: string, handle: () => boolean): void {
  $effect(() => {
    // MICA-27: routed through the implicit `lifecycle` facet, not a raw call naming
    // `navigation` directly — `useDeepLink` is implicit and this app may hold no
    // `navigation` permission at all (see MICA-31, the bug this replaces).
    if (handle()) void lifecycle(appId).consumeDeepLink();
  });
}

registerFacet('deepLink', deepLink);
