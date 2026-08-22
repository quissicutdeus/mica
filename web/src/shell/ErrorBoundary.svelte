<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goHome } from './state/navigation';
  import AppCrashed from './AppCrashed.svelte';

  /**
   * The fallback that stands between one app's crash and a dead phone.
   *
   * The fallback lives in the `failed` snippet, and it has to. It was previously an
   * `{#if error}` branch *inside* the boundary's children, driven by `$state` that
   * `onerror` set — which renders nothing at all. Svelte destroys the main effect the
   * moment it catches, and only re-renders if a `failed` snippet exists; the `{#if}`
   * branch was in the effect that had just been destroyed, so setting the flag updated
   * a tree that was no longer there. A crashed app left a blank screen with no way home,
   * and `handleReset` was unreachable.
   *
   * `reset` comes from Svelte rather than from a local flag for the same reason: clearing
   * our own state cannot rebuild the destroyed branch, and Svelte's own `reset` is what
   * re-creates it.
   */

  let {
    children,
    appName = 'App'
  }: {
    children: Snippet;
    appName?: string;
  } = $props();

  function handleError(e: unknown) {
    console.error(`[gPhone] ErrorBoundary caught crash in '${appName}':`, e);
  }

  /** `error` is `unknown` — only a real Error carries a stack worth printing. */
  const stackOf = (error: unknown): string | null =>
    error instanceof Error && error.stack ? error.stack : null;
</script>

<svelte:boundary onerror={handleError}>
  {@render children()}

  {#snippet failed(error, reset)}
    <AppCrashed
      {appName}
      stack={stackOf(error)}
      onRestart={reset}
      onHome={() => {
        reset();
        goHome();
      }}
    />
  {/snippet}
</svelte:boundary>
