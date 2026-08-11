<script lang="ts">
  import { EmptyState, Skeleton, usePagedList } from '@gphone/sdk';
  import { useBlabber } from '../store';
  import type { Blab } from '@shared/types';
  import BlabRow from './BlabRow.svelte';

  /**
   * Blabs carrying one tag — reached from an inline `#tag` tap, the Tags search segment, or a
   * trending chip. One screen, three ways in, per the design spec.
   */
  let {
    tag,
    onhandle,
    ontag,
    onopen,
    onmouth,
    onear
  }: {
    tag: string;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    onopen?: (blab: Blab) => void;
    onmouth?: (blab: Blab) => void;
    onear?: (blab: Blab) => void;
  } = $props();

  const { taggedBlabs, loadTaggedBlabs, engagement, loadEngagement } = useBlabber();
  const loaded = taggedBlabs.loaded;

  $effect(() => {
    void tag;
    void loadTaggedBlabs(tag);
  });

  const page = usePagedList<Blab>({
    items: () => $taggedBlabs,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: () => taggedBlabs.loadMore(),
    hasMore: () => hasMoreSnapshot
  });

  let hasMoreSnapshot = $state(false);
  taggedBlabs.hasMore.subscribe((value) => (hasMoreSnapshot = value));

  $effect(() => {
    const ids = page.visible.map((blab) => blab.id);
    if (ids.length > 0) void loadEngagement(ids);
  });
</script>

<div class="flex-1 overflow-y-auto pb-20" onscroll={page.onScroll}>
  {#if !$loaded}
    <div class="p-4"><Skeleton count={4} height="h-16" /></div>
  {:else if $taggedBlabs.length === 0}
    <EmptyState title="Nothing tagged yet" description="No Blabs carry #{tag} yet." />
  {:else}
    {#each page.visible as blab (blab.id)}
      <BlabRow
        {blab}
        stats={$engagement[blab.id]}
        {onhandle}
        {ontag}
        onreply={() => onopen?.(blab)}
        onmouth={() => onmouth?.(blab)}
        onear={() => onear?.(blab)}
        {onopen}
      />
    {/each}
    {#if page.loading}
      <div class="p-4"><Skeleton count={2} height="h-16" /></div>
    {/if}
  {/if}
</div>
