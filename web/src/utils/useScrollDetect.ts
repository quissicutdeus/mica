import { onMount } from 'svelte';

/**
 * Tracks whether any scrollable container with `.overflow-y-auto` has scrolled
 * past a threshold (default 20px). Returns a getter/setter pair for use with
 * Svelte 5 $state.
 *
 * Usage in a component:
 * ```ts
 * let isScrolled = $state(false);
 * useScrollDetect((v) => (isScrolled = v));
 * ```
 */
export function useScrollDetect(setter: (scrolled: boolean) => void, threshold: number = 20) {
  onMount(() => {
    const handleScroll = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target && target.classList.contains('overflow-y-auto')) {
        setter(target.scrollTop > threshold);
      }
    };
    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  });
}
