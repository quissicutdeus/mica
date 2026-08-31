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

<div class="pt-safe-top mt-2 flex items-center px-4 pb-3">
  {#if onback}
    <button
      class="bg-surface-container-high hover:bg-surface-container-high-hover active:bg-surface-container-high-pressed duration-short ease-standard -ml-2 rounded-full p-2 transition-colors"
      onclick={onback}
      aria-label="Go back"
    >
      <ChevronLeftIcon class="size-icon-lg" />
    </button>
  {/if}
  {#if ontitleclick}
    <h1 class="ml-2 min-w-0 truncate">
      <button
        type="button"
        class="group hover:text-primary duration-short ease-standard cursor-pointer truncate text-left text-xl font-semibold transition-colors"
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
