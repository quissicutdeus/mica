<script lang="ts">
  import type { Snippet } from "svelte";
  import { goHome } from "../store/navigation";

  let {
    children,
    appName = "App",
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
      class="flex h-full w-full flex-col items-center justify-center p-6 bg-gray-900 text-white text-center"
    >
      <div class="mb-4 rounded-full bg-red-500/20 p-4 text-red-400">
        <svg
          class="w-10 h-10"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <h2 class="text-xl font-bold mb-1 text-white">App Stopped Working</h2>
      <p class="text-sm text-gray-400 mb-6">
        The <span class="font-semibold text-gray-200 capitalize">{appName}</span
        > app encountered an unexpected error.
      </p>

      <div class="flex flex-col gap-3 w-full max-w-xs">
        <button
          type="button"
          onclick={handleReset}
          class="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-colors cursor-pointer"
        >
          Restart App
        </button>
        <button
          type="button"
          onclick={() => {
            handleReset();
            goHome();
          }}
          class="w-full py-2.5 px-4 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-xl font-medium transition-colors cursor-pointer border border-gray-700"
        >
          Return to Home Screen
        </button>
      </div>

      {#if import.meta.env.DEV && error?.stack}
        <div
          class="mt-6 w-full text-left bg-black/40 p-3 rounded-lg overflow-auto max-h-32 text-xs font-mono text-red-300 border border-red-900/50"
        >
          {error.stack}
        </div>
      {/if}
    </div>
  {:else}
    {@render children()}
  {/if}
</svelte:boundary>
