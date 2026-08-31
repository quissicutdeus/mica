<script lang="ts">
  /**
   * A placeholder for content that has been asked for and has not arrived.
   *
   * gPhone had no loading primitive at all, and the gap was not cosmetic: every list in
   * the phone starts empty, so the first frame after opening an app is indistinguishable
   * from having nothing. Bank rendered "No transactions" — a definite statement of fact —
   * for as long as the fetch took.
   *
   * `count` repeats the block, because a single gray bar reads as one real row while a
   * few read as a list arriving.
   *
   * ```svelte
   * {#if loading}
   *   <Skeleton count={3} height="h-14" />
   * {:else if items.length === 0}
   *   <EmptyState title="No transactions" />
   * {/if}
   * ```
   */
  let {
    count = 1,
    height = 'h-4',
    rounded = 'rounded-lg',
    class: className = ''
  }: {
    count?: number;
    /** A utility height class — rows are taller than lines of text. */
    height?: string;
    rounded?: string;
    class?: string;
  } = $props();
</script>

<div class="space-y-2" aria-busy="true" aria-live="polite">
  <span class="sr-only">Loading</span>
  {#each { length: count } as _, i (i)}
    <div class="bg-surface-container animate-pulse {height} {rounded} {className}"></div>
  {/each}
</div>
