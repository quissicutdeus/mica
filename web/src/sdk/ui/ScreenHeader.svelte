<script lang="ts">
  import type { Snippet } from 'svelte';
  import ChevronLeftIcon from './icons/ChevronLeftIcon.svelte';

  let {
    title,
    onback,
    ontitleclick,
    actions
  }: {
    title: string;
    onback?: () => void;
    ontitleclick?: () => void;
    actions?: Snippet;
  } = $props();
</script>

<div class="flex items-center border-b border-gray-700 bg-gray-800/50 px-4 py-4 backdrop-blur-md">
  {#if onback}
    <button
      class="-ml-2 rounded-full p-2 transition-colors hover:bg-gray-700"
      onclick={onback}
      aria-label="Go back"
    >
      <ChevronLeftIcon class="h-6 w-6" />
    </button>
  {/if}
  {#if ontitleclick}
    <h1 class="ml-2 min-w-0 truncate">
      <button
        type="button"
        class="group cursor-pointer truncate text-left text-xl font-semibold transition-colors hover:text-blue-400"
        onclick={ontitleclick}
      >
        <span class="truncate">{title}</span>
      </button>
    </h1>
  {:else}
    <h1 class="ml-2 truncate text-xl font-semibold">{title}</h1>
  {/if}
  {#if actions}
    {@render actions()}
  {/if}
</div>
