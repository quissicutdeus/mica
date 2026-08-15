<script lang="ts">
  import { SearchBar, SegmentedControl, EmptyState, Skeleton } from '@gphone/sdk';
  import { useBlabber } from '../store';
  import BlabRow from './BlabRow.svelte';

  let {
    onhandle,
    ontag,
    onopen
  }: {
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
    /**
     * `anchorId` is set whenever the result itself is a reply, so `BlabDetail` opens already
     * scrolled to the row that matched — however old it is — rather than landing on the top of
     * its flattened root with the match somewhere below the fold.
     */
    onopen?: (id: number, anchorId?: number) => void;
  } = $props();

  const {
    accountResults,
    searchAccounts,
    blabResults,
    searchBlabs,
    tagResults,
    searchTags,
    trendingTags,
    loadTrendingTags,
    engagement,
    loadEngagement
  } = useBlabber();

  // `PagedStore.loaded` is a nested `Readable`, not a plain field on the store's own array
  // value — subscribing to `accountResults` itself only ever yields the rows. Matches how
  // `index.svelte` reads `feed.loaded` for the same reason.
  const accountsLoaded = accountResults.loaded;
  const blabsLoaded = blabResults.loaded;

  let query = $state('');
  let segment = $state<'people' | 'blabs' | 'tags'>('people');

  $effect(() => {
    void loadTrendingTags();
  });

  /**
   * Below 2 characters, nothing fires. A single letter against a `LIKE '%x%'` body scan is close
   * to a full table scan on every keystroke, and this cuts the match rate sharply for cheap.
   */
  $effect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    if (segment === 'people') void searchAccounts(q);
    else if (segment === 'blabs') void searchBlabs(q);
    else void searchTags(q);
  });

  $effect(() => {
    if (segment !== 'blabs') return;
    const ids = $blabResults.map((b) => b.id);
    if (ids.length > 0) void loadEngagement(ids);
  });

  const showingTrending = $derived(query.trim().length < 2);
</script>

<div class="flex h-full flex-col">
  <div class="border-outline-variant space-y-2 border-b p-3">
    <SearchBar bind:value={query} placeholder="Search Blabber" focus={true} />
    <SegmentedControl
      selected={segment}
      onchange={(id) => (segment = id as typeof segment)}
      options={[
        { id: 'people', label: 'People' },
        { id: 'blabs', label: 'Blabs' },
        { id: 'tags', label: 'Tags' }
      ]}
    />
  </div>

  <div class="flex-1 overflow-y-auto pb-20">
    {#if showingTrending}
      {#if $trendingTags.length === 0}
        <EmptyState
          title="Nothing trending yet"
          description="Check back once people start posting."
        />
      {:else}
        <div class="flex flex-wrap gap-2 p-3">
          {#each $trendingTags as t (t.tag)}
            <button
              type="button"
              class="bg-surface-container text-on-surface text-body-small rounded-full px-3 py-1.5"
              onclick={() => ontag?.(t.tag)}
            >
              #{t.tag} · {t.uses}
            </button>
          {/each}
        </div>
      {/if}
    {:else if segment === 'people'}
      {#if !$accountsLoaded}
        <div class="p-4"><Skeleton count={4} height="h-14" /></div>
      {:else if $accountResults.length === 0}
        <EmptyState title="No people found" description="Try a different handle or name." />
      {:else}
        {#each $accountResults as account (account.id)}
          <button
            type="button"
            class="hover:bg-surface-container flex w-full items-center gap-3 px-4 py-3 text-left"
            onclick={() => onhandle?.(account.handle)}
          >
            <span class="text-on-surface text-body-medium">
              {account.display_name || account.handle}
            </span>
            <span class="text-on-surface-variant text-body-small">@{account.handle}</span>
          </button>
        {/each}
      {/if}
    {:else if segment === 'blabs'}
      {#if !$blabsLoaded}
        <div class="p-4"><Skeleton count={4} height="h-16" /></div>
      {:else if $blabResults.length === 0}
        <EmptyState title="No Blabs found" description="Try different words." />
      {:else}
        {#each $blabResults as blab (blab.id)}
          <BlabRow
            {blab}
            stats={$engagement[blab.id]}
            {onhandle}
            {ontag}
            onopen={() => onopen?.(blab.id, blab.reply_to != null ? blab.id : undefined)}
          />
        {/each}
      {/if}
    {:else if $tagResults.length === 0}
      <EmptyState title="No tags found" description="Try a shorter search." />
    {:else}
      {#each $tagResults as t (t.tag)}
        <button
          type="button"
          class="hover:bg-surface-container flex w-full items-center justify-between px-4 py-3 text-left"
          onclick={() => ontag?.(t.tag)}
        >
          <span class="text-on-surface text-body-medium">#{t.tag}</span>
          <span class="text-on-surface-variant text-body-small">{t.uses} Blabs</span>
        </button>
      {/each}
    {/if}
  </div>
</div>
