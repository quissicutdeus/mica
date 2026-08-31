<script lang="ts">
  import {
    CheckIcon,
    EmptyPhotoIcon,
    EmptyState,
    MediaThumb,
    Skeleton,
    usePagedList,
    useMedia
  } from '@gphone/sdk';
  import type { MediaItem } from '@gphone/shared/types';

  /**
   * The gallery grid — three columns of 123px tiles, a page at a time.
   *
   * Split out of `index.svelte` when MICA-110 gave it a scroller, a page window and a
   * hydration pass to run. The grid and the full-screen view share exactly one thing, the
   * photo that is open, and interleaving them in one file meant reading past forty lines of
   * the other to follow either.
   */
  let {
    isSelectionMode,
    selectedIds,
    onphotoclick
  }: {
    isSelectionMode: boolean;
    selectedIds: Set<number>;
    onphotoclick: (photo: MediaItem) => void;
  } = $props();

  const { media } = useMedia();
  const mediaLoaded = media.loaded;

  let hasMore = $state(false);
  media.hasMore.subscribe((value) => (hasMore = value));

  /**
   * A window over the store's window.
   *
   * Two layers, and they are not redundant: `createPagedStore` holds however many pages the
   * player has scrolled through, and this reveals them a screen at a time and asks the
   * server for the next page once nothing is left hidden locally. `olderAt: 'end'` because
   * a gallery grows downward — older photos are below, so revealing them changes nothing
   * the reader is already looking at and needs no scroll compensation.
   */
  const page = usePagedList<MediaItem>({
    items: () => $media,
    olderAt: 'end',
    // Matched to the store's server page rather than coincidentally equal to it: a local
    // window smaller than the page would hide rows already paid for, and a larger one would
    // ask the server for a second page before the first was on screen.
    pageSize: 21,
    loadOlder: () => media.loadMore(),
    hasMore: () => hasMore
  });

  /**
   * Offer every visible tile for hydration, and let the store decide.
   *
   * Whether a given row's bytes would draw is a question about the media table, and
   * answering it here would put a second, drifting copy of it in a template — so
   * `media.hydrate` holds the predicate and this passes it the row. What this file is
   * responsible for is the *scope*: `page.visible` rather than the whole store, which is the
   * difference between paying for the rows on screen and paying for the library again.
   *
   * `hydrate` is a no-op for a row that needs nothing and for one already asked for, so
   * re-running this effect on every reveal is free.
   */
  $effect(() => {
    for (const photo of page.visible) media.hydrate(photo);
  });
</script>

<div class="no-scrollbar bg-surface min-h-0 flex-1 overflow-y-auto p-1" onscroll={page.onScroll}>
  {#if !$mediaLoaded}
    <Skeleton count={4} height="h-24" rounded="rounded-none" />
  {:else if $media.length === 0}
    <EmptyState title="No photos yet">
      {#snippet icon()}
        <EmptyPhotoIcon class="h-16 w-16" />
      {/snippet}
    </EmptyState>
  {:else}
    <div class="grid grid-cols-3 gap-1">
      {#each page.visible as photo (photo.id)}
        <!-- A real button: the grid is the only way into a photo, and it was a bare
             div, so the gallery could not be opened from the keyboard at all. -->
        <button
          type="button"
          class="group bg-surface-container relative aspect-square cursor-pointer"
          onclick={() => onphotoclick(photo)}
          aria-pressed={isSelectionMode ? selectedIds.has(photo.id) : undefined}
          aria-label={isSelectionMode ? `Select photo ${photo.id}` : `Open photo ${photo.id}`}
        >
          <MediaThumb
            item={photo}
            alt="Capture {photo.id}"
            class="transition-opacity {isSelectionMode && selectedIds.has(photo.id)
              ? 'opacity-50'
              : 'group-hover:opacity-80'} duration-short ease-standard"
          />
          {#if isSelectionMode}
            <div
              class="absolute right-2 bottom-2 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white {selectedIds.has(
                photo.id
              )
                ? 'bg-primary'
                : 'bg-black/20 backdrop-blur-sm'}"
            >
              {#if selectedIds.has(photo.id)}
                <CheckIcon class="text-on-primary size-icon-sm" />
              {/if}
            </div>
          {/if}
        </button>
      {/each}
    </div>

    {#if page.loading}
      <div class="grid grid-cols-3 gap-1 pt-1">
        <Skeleton count={3} height="h-24" rounded="rounded-none" />
      </div>
    {/if}

    <!-- The scroller's own bottom padding, so the last row of tiles clears the gesture bar
         `PhoneFrame` paints full-width at z-60 (§5) instead of sitting a third inside it. -->
    <div class="h-home-indicator" aria-hidden="true"></div>
  {/if}
</div>
