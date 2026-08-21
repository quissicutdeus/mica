import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { currentApp } from '../../../../shell/state/navigation';

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
