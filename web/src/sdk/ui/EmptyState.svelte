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

<div
  class="text-on-surface-variant flex flex-1 flex-col items-center justify-center pb-20 {className}"
>
  {#if icon}
    <div class="mb-4 opacity-50">
      {@render icon()}
    </div>
  {/if}
  <p class="text-lg font-medium">{title}</p>
  {#if description}
    <p class="text-outline text-body-medium mt-1 max-w-[80%] text-center leading-relaxed">
      {description}
    </p>
  {/if}
</div>
