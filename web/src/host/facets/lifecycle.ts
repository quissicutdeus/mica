import { registerFacet } from '../../../../sdk/host/current';
import { onDestroy } from 'svelte';
import { currentApp, goHome, consumeAppProps } from '../../shell/state/navigation';
import { registerHandler } from '../../shell/state/keybinds';

/**
 * Executes a cleanup callback when the application component is unmounted or closed.
 */
export function onAppUnmount(handler: () => void): void {
  try {
    onDestroy(handler);
  } catch {
    // Graceful fallback if called outside Svelte lifecycle context
  }
}

/**
 * Implementation of the `onAppForeground` facet — see the `onAppForeground` hook doc for
 * the usage contract (the stale-balance rationale for why this exists).
 */
export function onAppForeground(appId: string, handler: () => void): () => void {
  const id = appId.toLowerCase();
  let wasForeground = false;

  const unsubscribe = currentApp.subscribe((app) => {
    const isForeground = app.id === id;
    // Only the transition. A store that republishes the same app — a deep link consuming
    // its props does exactly that — must not count as a second visit.
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
 * MICA-27: the one implicit, no-permission door a sandboxed add-on's baseline plumbing
 * reaches the shell through — `onAppForeground`/`onAppUnmount` (this file's own twin, over
 * `currentApp`), `useDeepLink` (`consumeDeepLink`), the `onback` prop every app gets
 * (`goHome`), and `useAppLevels`'s physical Back binding (`onBack`).
 *
 * Replaces `IframeHostServer.ts`'s old `isImplicitNavPlumbing` — a hand-maintained
 * facet/member allow-list keyed on literal strings, which is exactly the shape of bug
 * MICA-31 was: a legitimate implicit caller (`consumeDeepLink`) simply wasn't on the
 * list. A dedicated facet with its own `null` permission needs no such list — every
 * member here is implicit by construction, and the general `navigation`/`keybinds`
 * facets this used to borrow members from now require their real declared permissions
 * unconditionally, with no exemption at all.
 *
 * `appId` is this facet's one factory argument, so `IframeHostServer.ts` pins it via
 * `APP_SCOPED_FACETS` exactly like `storage`/`deepLink` — a raw message naming `lifecycle`
 * directly can state its own facet id (`factoryArgs[0]`) all it wants; the shell replaces
 * it before the factory ever sees it.
 */
export function lifecycle(appId: string) {
  const id = appId.toLowerCase();
  return {
    currentApp,
    /** Claim the physical Back key for as long as this component is mounted. */
    onBack: (handler: () => void): (() => void) => {
      const release = registerHandler('back', handler, id);
      try {
        onDestroy(release);
      } catch {
        // Called outside a component lifecycle; the caller owns cleanup.
      }
      return release;
    },
    goHome: () => goHome(),
    /**
     * Mark this app's deep-link props as handled, so they do not fire again. See
     * `useDeepLink`'s doc for the usage contract.
     */
    consumeDeepLink: () => consumeAppProps(appId)
  };
}

registerFacet('lifecycle', lifecycle);
