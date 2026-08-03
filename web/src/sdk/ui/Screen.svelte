<script lang="ts">
  import type { Snippet } from 'svelte';
  import ScreenHeader from './ScreenHeader.svelte';

  let {
    title,
    onback,
    ontitleclick,
    actions,
    overlay,
    children,
    class: className = ''
  } = $props<{
    title: string;
    onback?: () => void;
    ontitleclick?: () => void;
    actions?: Snippet;
    overlay?: Snippet;
    children: Snippet;
    class?: string;
  }>();
</script>

<div class="bg-surface relative flex h-full flex-col text-white {className}">
  <!-- Header -->
  <ScreenHeader {title} {onback} {ontitleclick} {actions} />

  <!-- Content -->
  <div class="no-scrollbar relative flex-1 overflow-y-auto">
    {@render children()}
  </div>

  {#if overlay}
    {@render overlay()}
  {/if}
</div>
