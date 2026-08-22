import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { onDestroy } from 'svelte';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/lifecycle').lifecycle>>;

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
    currentApp: store('lifecycle', [appId], 'currentApp', { id: '', props: {} }),
    // The inProcess twin's onBack returns the release function synchronously; over the
    // wire it can only promise one eventually (see appLevels.ts's own direct remoteCall,
    // which is why nothing here actually awaits this).
    onBack: (handler: () => void) =>
      fn('lifecycle', [appId], 'onBack')(handler) as unknown as ReturnType<Twin['onBack']>,
    goHome: () => fn('lifecycle', [appId], 'goHome')(),
    consumeDeepLink: () => fn('lifecycle', [appId], 'consumeDeepLink')()
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('lifecycle', lifecycle as unknown as Facets['lifecycle']);
