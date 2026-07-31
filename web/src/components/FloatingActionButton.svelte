<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    title,
    collapsed = false,
    onclick,
    icon
  } = $props<{
    label: string;
    title?: string;
    collapsed?: boolean;
    onclick: () => void;
    icon: Snippet;
  }>();
</script>

<button
  type="button"
  class="absolute right-5 bottom-5 z-30 flex cursor-pointer items-center justify-center rounded-full border border-blue-400/20 bg-gradient-to-r from-blue-600 to-indigo-600 text-xs font-medium text-white shadow-xl shadow-blue-600/30 transition-all duration-300 ease-in-out hover:from-blue-500 hover:to-indigo-500 active:scale-95 {collapsed
    ? 'h-11 w-11 p-0'
    : 'gap-2 px-4 py-2.5'}"
  {onclick}
  title={title || label}
  aria-label={label}
>
  {@render icon()}
  {#if !collapsed}
    <span class="whitespace-nowrap transition-all duration-300">{label}</span>
  {/if}
</button>
