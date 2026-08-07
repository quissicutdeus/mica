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
   * chosen by hand — M3's 8% overlay, flattened to an opaque value in `lib/m3.ts`. See
   * `app.css` for why it cannot be an opacity modifier.
   *
   * The filled accent is `primary-container`, not `primary`, and that is M3's own
   * filled-tonal button rather than a deviation. It matters because of where the chroma
   * lives: in a dark scheme `primary` is tone 80, and sRGB cannot hold saturation at a
   * light tone for a warm hue — a hot-pink seed arrives at chroma 35 there against 71 at
   * the container's tone 30. Picking a vivid color and getting a pastel button was the
   * complaint, and no palette variant fixes it, because the constraint is the tone.
   */
  let variantClass = $derived.by(() => {
    switch (variant) {
      case 'primary':
        return 'bg-primary-container hover:bg-primary-container-hover text-on-primary-container';
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
