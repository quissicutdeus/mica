// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { onDestroy } from 'svelte';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['lifecycle']>>;

/** Executes a cleanup callback when the application component is unmounted or closed. */
export function onAppUnmount(handler: () => void): void {
  try {
    onDestroy(handler);
  } catch {
    // Graceful fallback if called outside Svelte lifecycle context
  }
}

/**
 * Implementation of the `onAppForeground` facet — mirrors the inProcess twin's transition
 * logic, over the same `lifecycle.currentApp` twin store (MICA-27).
 */
export function onAppForeground(appId: string, handler: () => void): () => void {
  const id = appId.toLowerCase();
  const currentApp = store('lifecycle', [appId], 'currentApp', { id: '', props: {} });
  let wasForeground = false;

  const unsubscribe = currentApp.subscribe((app) => {
    const isForeground = app.id === id;
    if (isForeground && !wasForeground) handler();
    wasForeground = isForeground;
  });

  try {
    onDestroy(unsubscribe);
  } catch {
    // Called outside a component lifecycle; the returned function is the caller's to
    // hold onto, as with `onKeybind`.
  }
  return unsubscribe;
}

registerFacet('onAppForeground', onAppForeground);

registerFacet('onAppUnmount', onAppUnmount);

/**
 * The iframe twin of the `lifecycle` facet (MICA-27) — see the inProcess twin for the
 * full rationale. `appLevels.ts`, `boot.ts`, and `deepLink.svelte.ts` call this directly
 * rather than building their own `remoteCall`/`remoteStore` wiring, the same way they'd
 * reach any other facet's twin.
 */
export function lifecycle(appId: string): Twin {
  return {
    // This app while it is in front, and this same seed the rest of the time: the shell
    // scopes the store to the pinned app, so no other app's id or props ever arrive here.
    currentApp: store('lifecycle', [appId], 'currentApp', { id: '', props: {} }),
    // The inProcess twin's onBack returns the release function synchronously; over the
    // wire it can only promise one eventually (see appLevels.ts's own direct remoteCall,
    // which is why nothing here actually awaits this).
    onBack: (handler: () => void) =>
      fn('lifecycle', [appId], 'onBack')(handler) as unknown as ReturnType<Twin['onBack']>,
    goHome: () => fn('lifecycle', [appId], 'goHome')(),
    consumeDeepLink: () => fn('lifecycle', [appId], 'consumeDeepLink')(),
    // MICA-294. `false` until the shell's first push, which arrives on subscribe: an add-on
    // that waits for `true` before starting work does nothing wrong in the gap, and one that
    // assumed `true` would poll a phone it had never been told was open.
    visible: store('lifecycle', [appId], 'visible', false)
  };
}

// No cast: every store member here is a `Readable` in the facet's own type, so the twin
// already is what an iframe can honestly offer (MICA-26).
registerFacet('lifecycle', lifecycle);
