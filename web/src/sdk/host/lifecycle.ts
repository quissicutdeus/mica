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
 */
export function onAppForeground(appId: string, handler: () => void): () => void {
  return guarded('onAppForeground', appId).facets.onAppForeground(appId, handler);
}
