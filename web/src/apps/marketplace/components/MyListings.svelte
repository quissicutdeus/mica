<script lang="ts">
  import { onMount } from 'svelte';
  import { useMarketplace } from '../../../sdk/hooks/useMarketplace';
  import { EmptyState, Skeleton } from '@gphone/sdk';

  let { onback }: { onback: () => void } = $props();

  const { mineStore, loadMine, markSold, removeListing } = useMarketplace();

  let loaded = $state(false);

  onMount(() => {
    void loadMine().then(() => (loaded = true));
  });
</script>

<div class="flex items-center gap-2 p-4">
  <button type="button" onclick={onback} aria-label="Back" class="text-on-surface-variant">
    ←
  </button>
  <p class="text-on-surface text-title-medium">My Listings</p>
</div>

{#if !loaded}
  <div class="p-4"><Skeleton count={3} height="h-16" /></div>
{:else if $mineStore.rows.length === 0}
  <EmptyState title="No listings yet" description="Post something from the Feed." />
{:else}
  <ul class="flex flex-col gap-2 px-4 pb-4">
    {#each $mineStore.rows as row (row.id)}
      <li class="bg-surface-container flex items-center justify-between rounded-xl p-3">
        <div class="min-w-0">
          <p class="text-on-surface truncate text-body-large">{row.title}</p>
          <p class="text-on-surface-variant text-body-small">{row.price} · {row.status}</p>
        </div>
        {#if row.status === 'active'}
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              aria-label="Mark Sold"
              onclick={() => markSold(row.id)}
              class="text-primary text-label-medium"
            >
              Mark Sold
            </button>
            <button
              type="button"
              aria-label="Remove"
              onclick={() => removeListing(row.id)}
              class="text-error text-label-medium"
            >
              Remove
            </button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
