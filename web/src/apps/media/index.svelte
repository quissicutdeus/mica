<script lang="ts">
  import {
    ReportDialog,
    Screen,
    ConfirmDialog,
    RecentlyDeleted,
    ShareSquareIcon,
    TrashIcon,
    onAppForeground,
    useAppAction,
    useAppEvents,
    useAppLevels,
    useDeepLink,
    useMedia,
    usePhoneNotification,
    type AppProps,
    type RecentlyDeletedItem,
    fade
  } from '@gphone/sdk';
  import type { MediaItem } from '@gphone/shared/types';
  import PhotoGrid from './components/PhotoGrid.svelte';
  import PhotoDetail from './components/PhotoDetail.svelte';

  import { SvelteSet } from 'svelte/reactivity';

  let {
    onback,
    initialPhoto,
    initialPhotoId
  }: AppProps & { initialPhoto?: MediaItem; initialPhotoId?: number } = $props();

  const { media, deletePhoto, dropNearby, getDeletedMedia, restoreMedia } = useMedia();
  const { busy, run } = useAppAction('media');
  const { toast } = usePhoneNotification();

  let selectedPhoto: MediaItem | null = $state(null);
  let isSelectionMode = $state(false);
  const selectedIds = new SvelteSet<number>();
  let showDeleteConfirm = $state(false);
  let reporting = $state(false);
  let showRecentlyDeleted = $state(false);
  // `MediaPreview` plus the deletion timestamp it deliberately carries no field for —
  // inferred from the facet call rather than a new SDK-exported type for one local.
  let deletedMedia = $state<Awaited<ReturnType<typeof getDeletedMedia>>>([]);

  /**
   * A fresh first page on every foreground.
   *
   * `load` replaces the window rather than appending to it, so coming back to the app also
   * drops however far the player had paged — which is the right trade: the top of the
   * gallery is what they are returning to look at, and the pages below it are one scroll
   * away. What it no longer does is pull the whole library, because the window is a page of
   * thumbnails now instead of every row with its bytes attached (MICA-110).
   */
  onAppForeground('media', () => {
    void media.load();
  });

  /**
   * A drop landed while the gallery was open.
   *
   * This used to call `media.load()`, which refetched every photo the player was already
   * looking at to show them one new one — half of what made this the slowest app on the
   * phone. `receive` takes the notice for what it is: it reads the head of the list and
   * prepends what it does not already hold, leaving the rest of the window alone.
   */
  useAppEvents('media').on<{ id?: number }>('media_received', (e) => {
    void media.receive(e.payload?.id);
  });

  useDeepLink('media', () => {
    if (initialPhoto) {
      selectedPhoto = initialPhoto;
      return true;
    }
    if (!initialPhotoId) return false;

    // Read the store reactively: on a cold open the photo list has not arrived yet, and
    // the link must survive until it does.
    const found = $media.find((p) => p.id === initialPhotoId);
    if (!found) return false;

    selectedPhoto = found;
    return true;
  });

  const toggleSelectionMode = () => {
    isSelectionMode = !isSelectionMode;
    if (!isSelectionMode) {
      selectedIds.clear();
    }
  };

  const handlePhotoClick = (photo: MediaItem) => {
    if (isSelectionMode) {
      if (selectedIds.has(photo.id)) {
        selectedIds.delete(photo.id);
      } else {
        selectedIds.add(photo.id);
      }
    } else {
      selectedPhoto = photo;
    }
  };

  const deleteSelected = async () => {
    const count = selectedIds.size;
    const deleted = await run(
      async () => {
        for (const id of Array.from(selectedIds)) await deletePhoto(id);
      },
      { success: `${count} ${count === 1 ? 'photo' : 'photos'} deleted` }
    );
    if (!deleted) return;

    selectedIds.clear();
    isSelectionMode = false;
    showDeleteConfirm = false;
  };

  /**
   * Fans out to the same `dropNearby` path `sendNearby` uses below, once per selected
   * photo. Caught per-photo rather than left to `run` — one bad photo throwing would
   * otherwise collapse the whole batch into `run`'s generic error toast and hide
   * however many of the others actually went through. `recipientCount` takes the
   * largest count seen rather than summing: it's "how many nearby people," which
   * doesn't grow by sending them a second photo.
   */
  const shareSelected = async () => {
    const ids = Array.from(selectedIds);
    const total = ids.length;
    let sent = 0;
    let failed = 0;
    let recipientCount = 0;

    await run(async () => {
      for (const id of ids) {
        try {
          const result = await dropNearby(id);
          const count = result?.count ?? 0;
          if (count > 0) {
            sent++;
            recipientCount = Math.max(recipientCount, count);
          }
        } catch {
          failed++;
        }
      }
    });

    selectedIds.clear();
    isSelectionMode = false;

    if (failed > 0) {
      toast.show({
        type: sent > 0 ? 'warning' : 'error',
        app: 'media',
        message:
          sent > 0
            ? `${sent} of ${total} photos sent to ${recipientCount} nearby ${recipientCount === 1 ? 'phone' : 'phones'}. ${failed} failed.`
            : `Could not send ${failed === 1 ? 'the photo' : 'the photos'}. Try again.`
      });
      return;
    }

    toast.show({
      type: sent > 0 ? 'success' : 'info',
      app: 'media',
      message:
        sent > 0
          ? `${sent} ${sent === 1 ? 'photo' : 'photos'} sent to ${recipientCount} nearby ${recipientCount === 1 ? 'phone' : 'phones'}.`
          : 'No Bluetooth-visible players are in range.'
    });
  };

  const sendNearby = async () => {
    if (!selectedPhoto) return;
    const mediaId = selectedPhoto.id;

    let count = 0;
    const done = await run(async () => {
      const result = await dropNearby(mediaId);
      count = result?.count ?? 0;
    });
    if (!done) return;

    toast.show({
      type: count > 0 ? 'success' : 'info',
      app: 'media',
      message:
        count > 0
          ? `Sent to ${count} nearby ${count === 1 ? 'phone' : 'phones'}.`
          : 'No Bluetooth-visible players are in range.'
    });
  };

  const deleteSingle = async () => {
    if (!selectedPhoto) return;
    if (!(await run(() => deletePhoto(selectedPhoto!.id), { success: 'Photo deleted' }))) return;

    selectedPhoto = null;
    showDeleteConfirm = false;
  };

  /**
   * "Recently Deleted" (MICA-75-wiring). A fresh read every time it's opened rather
   * than a cached store — the screen is visited rarely enough that this is the right
   * cost, and it means a photo deleted moments ago is already there.
   */
  const openRecentlyDeleted = async () => {
    showRecentlyDeleted = true;
    deletedMedia = await getDeletedMedia();
  };

  const recentlyDeletedItems = $derived<RecentlyDeletedItem[]>(
    deletedMedia.map((m) => ({
      id: m.id,
      label: m.alt_text || (m.kind === 'photo' ? 'Photo' : m.kind),
      deletedAt: m.updated_at
    }))
  );

  const restoreDeletedMedia = async (id: string | number) => {
    // `restoreMedia` resolves to `false` rather than throwing on a refusal (past the
    // restore window, most likely), so `run` — which only reacts to a thrown error —
    // has to be told about that refusal explicitly.
    const restored = await run(
      async () => {
        if (!(await restoreMedia(Number(id)))) {
          throw new Error('This can no longer be restored.');
        }
      },
      { success: 'Restored' }
    );
    if (restored) deletedMedia = deletedMedia.filter((m) => m.id !== id);
  };

  const app = useAppLevels({
    appId: 'media',
    title: 'Media',
    onback: () => onback(),
    levels: [
      { open: () => reporting, close: () => (reporting = false) },
      { open: () => showDeleteConfirm, close: () => (showDeleteConfirm = false) },
      { open: () => !!selectedPhoto, close: () => (selectedPhoto = null), title: 'Photo' },
      {
        open: () => isSelectionMode,
        close: () => {
          isSelectionMode = false;
          selectedIds.clear();
        }
      },
      {
        open: () => showRecentlyDeleted,
        close: () => (showRecentlyDeleted = false),
        title: 'Recently Deleted'
      }
    ]
  });
</script>

{#snippet headerActions()}
  {#if !selectedPhoto && !showRecentlyDeleted}
    <button
      class="text-primary hover:bg-surface-container-high duration-short ease-standard ml-auto rounded-full p-2 font-semibold transition-colors"
      onclick={toggleSelectionMode}
    >
      {isSelectionMode ? 'Cancel' : 'Select'}
    </button>
    {#if !isSelectionMode}
      <button
        class="text-on-surface hover:bg-surface-container-high duration-short ease-standard rounded-full p-2 transition-colors"
        onclick={openRecentlyDeleted}
        title="Recently Deleted"
        aria-label="Recently Deleted"
      >
        <TrashIcon class="size-icon-md" />
      </button>
    {/if}
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions}>
  {#if showRecentlyDeleted}
    <!-- No `onpermanentdelete` (MICA-75-wiring): the server ships no hard-delete this
         round — soft-deleted stays soft-deleted forever — so this is restore-only. -->
    <RecentlyDeleted
      items={recentlyDeletedItems}
      onrestore={restoreDeletedMedia}
      emptyTitle="No deleted photos"
      emptyDescription="Photos you delete stick around here until the restore window closes."
    />
  {:else if selectedPhoto}
    <PhotoDetail
      photo={selectedPhoto}
      busy={$busy}
      {showDeleteConfirm}
      onsend={sendNearby}
      onreport={() => (reporting = true)}
      ondeleterequest={() => (showDeleteConfirm = true)}
      ondeletecancel={() => (showDeleteConfirm = false)}
      ondeleteconfirm={deleteSingle}
    />
  {:else}
    <!-- The grid scrolls; this wrapper does not. The selection bar below is positioned
         against *this*, so it stays put instead of scrolling away with the tiles — which
         is what it did while the grid was short enough never to scroll. -->
    <div class="relative flex min-h-0 flex-1 flex-col">
      <PhotoGrid {isSelectionMode} {selectedIds} onphotoclick={handlePhotoClick} />

      {#if isSelectionMode && selectedIds.size > 0}
        <!-- The padding is on the wrapper, not the bar: the bar has a border and a rounded
             corner, so growing *it* would put that border under the gesture bar rather than
             above it. §5 — anything anchored to the bottom clears the home indicator. -->
        <div class="pb-home-indicator pointer-events-none absolute right-4 bottom-4 left-4">
          <div
            class="border-outline-variant bg-surface-container shadow-elevation-5 pointer-events-auto flex items-center justify-between rounded-lg border p-4 backdrop-blur-md"
            transition:fade
          >
            <span class="text-on-surface font-medium">{selectedIds.size} Selected</span>
            <div class="flex gap-4">
              <button
                class="text-primary hover:text-primary"
                aria-label="Share selected"
                onclick={shareSelected}
              >
                <ShareSquareIcon class="size-icon-md" />
              </button>
              <button
                class="text-error hover:text-error"
                aria-label="Delete selected"
                onclick={() => (showDeleteConfirm = true)}
              >
                <TrashIcon class="size-icon-md" />
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if showDeleteConfirm && isSelectionMode}
        <ConfirmDialog
          title="Delete {selectedIds.size} Photos?"
          message="Are you sure you want to delete these photos? This cannot be undone."
          confirmText="Delete"
          isLoading={$busy}
          oncancel={() => (showDeleteConfirm = false)}
          onconfirm={deleteSelected}
        />
      {/if}
    </div>
  {/if}
</Screen>

{#if reporting && selectedPhoto}
  <ReportDialog
    targetTable="gphone_media"
    targetId={selectedPhoto.id}
    appId="media"
    onclose={() => (reporting = false)}
  />
{/if}
