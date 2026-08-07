<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goHome } from './state/navigation';

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
    <div
      class="bg-surface text-on-surface flex h-full w-full flex-col items-center justify-center p-6 text-center"
    >
      <div class="bg-error-container text-on-error-container mb-4 rounded-full p-4">
        <svg class="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <h2 class="text-on-surface mb-1 text-xl font-bold">App Stopped Working</h2>
      <p class="text-on-surface-variant mb-6 text-sm">
        The <span class="text-on-surface font-semibold capitalize">{appName}</span> app encountered an
        unexpected error.
      </p>

      <div class="flex w-full max-w-xs flex-col gap-3">
        <button
          type="button"
          onclick={reset}
          class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover w-full cursor-pointer rounded-xl px-4 py-2.5 font-medium transition-colors"
        >
          Restart App
        </button>
        <button
          type="button"
          onclick={() => {
            reset();
            goHome();
          }}
          class="border-outline-variant bg-surface-container text-on-surface hover:bg-surface-container-high w-full cursor-pointer rounded-xl border px-4 py-2.5 font-medium transition-colors"
        >
          Return to Home Screen
        </button>
      </div>

      {#if import.meta.env.DEV && stackOf(error)}
        <div
          class="border-error bg-error-container text-on-error-container mt-6 max-h-32 w-full overflow-auto rounded-lg border p-3 text-left font-mono text-xs"
        >
          {stackOf(error)}
        </div>
      {/if}
    </div>
  {/snippet}
</svelte:boundary>
