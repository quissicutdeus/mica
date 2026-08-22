<script lang="ts">
  /**
   * The crash fallback's markup, lifted out of `ErrorBoundary.svelte`'s `failed` snippet
   * so `AddOnFrame.svelte` can show the same screen for an add-on that crashed inside its
   * own iframe rather than inside `<svelte:boundary>` — `onerror` never fires for those,
   * since nothing there throws into this document.
   */
  let {
    appName,
    message = null,
    stack,
    onRestart,
    onHome
  }: {
    appName: string;
    /**
     * The error's own message, when the caller has one.
     *
     * `ErrorBoundary` catches a real `Error` and its `stack` already begins with the
     * message, so it passes none. An add-on crashing inside its sandboxed iframe
     * (`AddOnFrame`) only ever gets what survived `postMessage`, and a rejection whose
     * reason was not an `Error` arrives with `stack: null` — message-only. Without this
     * the DEV panel showed nothing at all for exactly the failures that are hardest to
     * reproduce, since the frame's own console is not the shell's.
     */
    message?: string | null;
    stack: string | null;
    onRestart: () => void;
    onHome: () => void;
  } = $props();

  /** DEV-only diagnostics: the message when there is no stack to subsume it, else both. */
  const detail = $derived(stack && message ? `${message}\n\n${stack}` : (stack ?? message));
</script>

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
  <p class="text-on-surface-variant text-body-medium mb-6">
    The <span class="text-on-surface font-semibold capitalize">{appName}</span> app encountered an unexpected
    error.
  </p>

  <div class="flex w-full max-w-xs flex-col gap-3">
    <button
      type="button"
      onclick={onRestart}
      class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover duration-short ease-standard w-full cursor-pointer rounded-xl px-4 py-2.5 font-medium transition-colors"
    >
      Restart App
    </button>
    <button
      type="button"
      onclick={onHome}
      class="border-outline-variant bg-surface-container text-on-surface hover:bg-surface-container-high duration-short ease-standard w-full cursor-pointer rounded-xl border px-4 py-2.5 font-medium transition-colors"
    >
      Return to Home Screen
    </button>
  </div>

  {#if import.meta.env.DEV && detail}
    <div
      class="border-error bg-error-container text-on-error-container text-body-small mt-6 max-h-32 w-full overflow-auto rounded-lg border p-3 text-left font-mono whitespace-pre-wrap"
    >
      {detail}
    </div>
  {/if}
</div>
