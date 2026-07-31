<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    icon?: Snippet;
    class?: string;
  }

  let { title, description, icon, class: className = '' }: Props = $props();
</script>

<div class="flex flex-1 flex-col items-center justify-center pb-20 text-gray-500 {className}">
  {#if icon}
    <div class="mb-4 opacity-50">
      {@render icon()}
    </div>
  {/if}
  <p class="text-lg font-medium">{title}</p>
  {#if description}
    <p class="mt-1 max-w-[80%] text-center text-sm leading-relaxed text-gray-600">
      {description}
    </p>
  {/if}
</div>
