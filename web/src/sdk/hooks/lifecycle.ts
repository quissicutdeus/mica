import { onMount, onDestroy } from 'svelte';

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
  try {
    onDestroy(handler);
  } catch {
    // Graceful fallback if called outside Svelte lifecycle context
  }
}
