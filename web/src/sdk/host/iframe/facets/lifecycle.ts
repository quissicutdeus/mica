import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { store } from './_shared';

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
 * logic, over the same `navigation.currentApp` twin store.
 */
export function onAppForeground(appId: string, handler: () => void): () => void {
  const id = appId.toLowerCase();
  const currentApp = store('navigation', [], 'currentApp', { id: '', props: {} });
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
