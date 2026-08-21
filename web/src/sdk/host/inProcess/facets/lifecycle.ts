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
 * Executes a callback every time the app comes to the front, including the first time.
 *
 * Residency made this necessary and there was no way to write it by hand. An app is
 * mounted once and then merely hidden, so `onAppMount` fires once per session — an app
 * that fetches there shows whatever was true when it was first opened, for as long as
 * the phone stays open. Bank was the visible case: spend money elsewhere, reopen Bank,
 * and the balance is the old one.
 *
 * Use it for anything the server can change without telling the phone. Data that arrives
 * by push — mail, messages — already updates its store while the app is backgrounded and
 * does not need this.
 *
 * The app names itself, as it does for `consumeDeepLink`. The shell has no way to hand a
 * component its own registry id.
 *
 * ```ts
 * onAppForeground('bank', () => {
 *   void fetchBalance();
 *   void fetchTransactions();
 * });
 * ```
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
