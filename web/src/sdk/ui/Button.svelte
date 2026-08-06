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

  /**
   * Each variant is a filled M3 container plus the `on-` role that belongs to it. The
   * pairing is the whole point: nothing here picks a text color independently, so a
   * button stays legible under any seed the player sets.
   *
   * Hover uses a pre-composited state-layer token rather than a second, lighter color
   * chosen by hand. `primary`/`primary-hover` is M3's 8% `on-primary` overlay flattened
   * to an opaque value in `lib/m3.ts` — see `app.css` for why it cannot be an opacity
   * modifier.
   */
  let variantClass = $derived.by(() => {
    switch (variant) {
      case 'primary':
        return 'bg-primary hover:bg-primary-hover text-on-primary';
      case 'secondary':
        return 'bg-surface-container-high hover:bg-surface-container-high-hover text-on-surface';
      case 'danger':
        return 'bg-error hover:bg-error-hover text-on-error font-bold';
      case 'icon':
        return 'hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface';
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
