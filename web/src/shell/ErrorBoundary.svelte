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
      class="flex h-full w-full flex-col items-center justify-center bg-gray-900 p-6 text-center text-white"
    >
      <div class="mb-4 rounded-full bg-red-500/20 p-4 text-red-400">
        <svg class="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <h2 class="mb-1 text-xl font-bold text-white">App Stopped Working</h2>
      <p class="mb-6 text-sm text-gray-400">
        The <span class="font-semibold text-gray-200 capitalize">{appName}</span> app encountered an unexpected
        error.
      </p>

      <div class="flex w-full max-w-xs flex-col gap-3">
        <button
          type="button"
          onclick={reset}
          class="w-full cursor-pointer rounded-xl bg-blue-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-blue-500"
        >
          Restart App
        </button>
        <button
          type="button"
          onclick={() => {
            reset();
            goHome();
          }}
          class="w-full cursor-pointer rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 font-medium text-gray-200 transition-colors hover:bg-gray-700"
        >
          Return to Home Screen
        </button>
      </div>

      {#if import.meta.env.DEV && stackOf(error)}
        <div
          class="mt-6 max-h-32 w-full overflow-auto rounded-lg border border-red-900/50 bg-black/40 p-3 text-left font-mono text-xs text-red-300"
        >
          {stackOf(error)}
        </div>
      {/if}
    </div>
  {/snippet}
</svelte:boundary>
