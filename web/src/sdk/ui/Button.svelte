<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  interface Props extends HTMLButtonAttributes {
    variant?: 'primary' | 'secondary' | 'danger' | 'icon';
    children?: Snippet;
  }

  let { variant = 'primary', class: className = '', children, ...rest }: Props = $props();

  let baseClass = $derived(
    variant === 'icon'
      ? 'p-2 rounded-full transition-colors disabled:opacity-50 flex items-center justify-center'
      : 'p-3 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center justify-center'
  );

  let variantClass = $derived.by(() => {
    switch (variant) {
      case 'primary':
        return 'bg-blue-600 hover:bg-blue-500 text-white';
      case 'secondary':
        return 'bg-gray-700 hover:bg-gray-600 text-white';
      case 'danger':
        return 'bg-danger hover:bg-danger-hover text-white font-bold';
      case 'icon':
        return 'hover:bg-gray-700 text-gray-300 hover:text-white';
      default:
        return '';
    }
  });
</script>

<button class="{baseClass} {variantClass} {className}" {...rest}>
  {#if children}
    {@render children()}
  {/if}
</button>
