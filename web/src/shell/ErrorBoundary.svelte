<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goHome } from './state/navigation';

  let {
    children,
    appName = 'App'
  }: {
    children: Snippet;
    appName?: string;
  } = $props();

  let error = $state<Error | null>(null);

  function handleError(e: unknown) {
    console.error(`[gPhone] ErrorBoundary caught crash in '${appName}':`, e);
    error = e instanceof Error ? e : new Error(String(e));
  }

  function handleReset() {
    error = null;
  }
</script>

<svelte:boundary onerror={handleError}>
  {#if error}
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
          onclick={handleReset}
          class="w-full cursor-pointer rounded-xl bg-blue-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-blue-500"
        >
          Restart App
        </button>
        <button
          type="button"
          onclick={() => {
            handleReset();
            goHome();
          }}
          class="w-full cursor-pointer rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 font-medium text-gray-200 transition-colors hover:bg-gray-700"
        >
          Return to Home Screen
        </button>
      </div>

      {#if import.meta.env.DEV && error?.stack}
        <div
          class="mt-6 max-h-32 w-full overflow-auto rounded-lg border border-red-900/50 bg-black/40 p-3 text-left font-mono text-xs text-red-300"
        >
          {error.stack}
        </div>
      {/if}
    </div>
  {:else}
    {@render children()}
  {/if}
</svelte:boundary>
