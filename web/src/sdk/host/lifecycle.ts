import { onMount } from 'svelte';
import './inProcess/facets/lifecycle';
import { guarded } from './guard';

/**
 * Executes a callback when the application component mounts into the gPhone shell.
 */
export function onAppMount(handler: () => void): void {
  try {
    onMount(handler);
  } catch {
    // Graceful fallback if called outside Svelte lifecycle context
    handler();
  }
}

/**
 * Executes a cleanup callback when the application component is unmounted or closed.
 */
export function onAppUnmount(handler: () => void): void {
  guarded('onAppUnmount').facets.onAppUnmount(handler);
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
  return guarded('onAppForeground', appId).facets.onAppForeground(appId, handler);
}
