<script lang="ts">
  import { onMount } from 'svelte';
  import { EmptyState, Skeleton, MediaThumb, useMarketplace } from '@gphone/sdk';
  import type { Listing } from '@shared/types';

  let {
    onselect,
    onCreate,
    onMyListings
  }: {
    onselect: (id: number) => void;
    onCreate: () => void;
    onMyListings: () => void;
  } = $props();

  const { feedStore, loadFeed, searchListings } = useMarketplace();

  let loaded = $state(false);
  let query = $state('');
  let searchResults = $state<Listing[] | null>(null);
  let debounceHandle: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    void loadFeed().then(() => (loaded = true));
  });

  const onSearchInput = (event: Event) => {
    query = (event.target as HTMLInputElement).value;
    clearTimeout(debounceHandle);
    if (!query) {
      searchResults = null;
      return;
    }
    debounceHandle = setTimeout(async () => {
      const page = await searchListings(query);
      searchResults = page.rows;
    }, 300);
  };

  const rows = $derived(searchResults ?? $feedStore.rows);
</script>

<div class="flex items-center gap-2 p-4 pb-2">
  <input
    type="search"
    placeholder="Search listings"
    value={query}
    oninput={onSearchInput}
    class="bg-surface-container text-on-surface placeholder:text-on-surface-variant text-body-medium flex-1 rounded-full px-4 py-2"
  />
  <button
    type="button"
    onclick={onMyListings}
    class="text-on-surface-variant hover:text-primary text-label-large"
  >
    My Listings
  </button>
  <button
    type="button"
    onclick={onCreate}
    aria-label="Create listing"
    class="bg-primary text-on-primary text-title-medium flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
  >
    +
  </button>
</div>

<div class="flex flex-col gap-2 px-4 pb-4">
  {#if !loaded}
    <Skeleton count={4} height="h-20" />
  {:else if rows.length === 0}
    <EmptyState title="No listings" description="Nothing matches yet." />
  {:else}
    {#each rows as listing (listing.id)}
      <button
        type="button"
        onclick={() => onselect(listing.id)}
        class="bg-surface-container hover:bg-surface-container-high duration-short ease-standard flex items-center gap-3 rounded-xl p-3 text-left transition-colors"
      >
        {#if listing.attachments?.[0]}
          <MediaThumb item={listing.attachments[0].media} class="h-14 w-14 shrink-0 rounded-lg" />
        {:else}
          <div class="bg-surface-container-high h-14 w-14 shrink-0 rounded-lg"></div>
        {/if}
        <div class="min-w-0 flex-1">
          <p class="text-on-surface truncate text-body-large">{listing.title}</p>
          <p class="text-on-surface-variant text-body-small">{listing.price}</p>
        </div>
      </button>
    {/each}
  {/if}
</div>
