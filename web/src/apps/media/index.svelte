<script lang="ts">
  import {
    CheckIcon,
    ConfirmDialog,
    EmptyPhotoIcon,
    EmptyState,
    ReportButton,
    ReportDialog,
    Screen,
    Skeleton,
    ShareSquareIcon,
    TrashIcon,
    onAppForeground,
    useAppAction,
    useAppEvents,
    useAppLevels,
    MediaThumb,
    useDeepLink,
    useMedia,
    usePhoneNotification,
    type AppProps
  } from '@gphone/sdk';
  import type { MediaItem } from '@shared/types';
  import { fade } from 'svelte/transition';

  let {
    onback,
    initialPhoto,
    initialPhotoId
  }: AppProps & { initialPhoto?: MediaItem; initialPhotoId?: number } = $props();

  const { media, deletePhoto, dropNearby } = useMedia();
  const mediaLoaded = media.loaded;
  const { busy, run } = useAppAction('media');
  const { toast } = usePhoneNotification();

  let selectedPhoto: MediaItem | null = $state(null);
  let isSelectionMode = $state(false);
  let selectedIds = $state<Set<number>>(new Set());
  let showDeleteConfirm = $state(false);
  let reporting = $state(false);

  onAppForeground('media', () => {
    void media.load();
  });

  // A drop landed while the gallery was already open — onAppForeground alone would miss
  // it until the app is reopened. The push is the notice; the fetch is still what feeds
  // the list, same as every other app's push contract.
  useAppEvents('media').on('media_received', () => {
    void media.load();
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
      selectedIds = new Set(selectedIds); // Trigger reactivity
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

  const shareSelected = () => {
    // Not implemented. Says so, rather than an `alert()` claiming it worked.
    toast.show({ type: 'info', app: 'media', message: 'Sharing photos is not implemented yet' });
    selectedIds.clear();
    isSelectionMode = false;
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
      }
    ]
  });
</script>

{#snippet headerActions()}
  {#if !selectedPhoto}
    <button
      class="text-primary hover:bg-surface-container-high ml-auto rounded-full p-2 font-semibold transition-colors"
      onclick={toggleSelectionMode}
    >
      {isSelectionMode ? 'Cancel' : 'Select'}
    </button>
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions}>
  {#if selectedPhoto}
    <!-- Full Screen Image View -->
    <div class="relative flex h-full flex-col bg-black" transition:fade>
      <div class="flex flex-1 items-center justify-center p-2">
        <MediaThumb item={selectedPhoto} fit="contain" alt="Photo {selectedPhoto.id}" />
      </div>

      <div
        class="border-outline-variant flex justify-between border-t bg-black/80 p-4 pb-8 backdrop-blur"
      >
        <button
          class="text-primary hover:text-primary p-2 transition-colors"
          aria-label="Send to nearby devices"
          disabled={$busy}
          onclick={sendNearby}
        >
          <ShareSquareIcon class="h-6 w-6" />
        </button>
        <ReportButton subject="photo" size="header" onclick={() => (reporting = true)} />
        <button
          class="text-error hover:text-error p-2 transition-colors"
          aria-label="Delete photo"
          onclick={() => (showDeleteConfirm = true)}
        >
          <TrashIcon class="h-6 w-6" />
        </button>
      </div>

      {#if showDeleteConfirm}
        <ConfirmDialog
          title="Delete Photo?"
          message="Are you sure you want to delete this photo?"
          confirmText="Delete"
          isLoading={$busy}
          oncancel={() => (showDeleteConfirm = false)}
          onconfirm={deleteSingle}
        />
      {/if}
    </div>
  {:else}
    <!-- Grid View -->
    <div class="no-scrollbar bg-surface relative h-full overflow-y-auto p-1">
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
          {#each $media as photo (photo.id)}
            <!-- A real button: the grid is the only way into a photo, and it was a bare
                 div, so the gallery could not be opened from the keyboard at all. -->
            <button
              type="button"
              class="group bg-surface-container relative aspect-square cursor-pointer"
              onclick={() => handlePhotoClick(photo)}
              aria-pressed={isSelectionMode ? selectedIds.has(photo.id) : undefined}
              aria-label={isSelectionMode ? `Select photo ${photo.id}` : `Open photo ${photo.id}`}
            >
              <MediaThumb
                item={photo}
                alt="Capture {photo.id}"
                class="transition-opacity {isSelectionMode && selectedIds.has(photo.id)
                  ? 'opacity-50'
                  : 'group-hover:opacity-80'}"
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
                    <CheckIcon class="text-on-surface h-4 w-4" />
                  {/if}
                </div>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      {#if isSelectionMode && selectedIds.size > 0}
        <div
          class="border-outline-variant bg-surface-container absolute right-4 bottom-4 left-4 flex items-center justify-between rounded-2xl border p-4 shadow-2xl backdrop-blur-md"
          transition:fade
        >
          <span class="text-on-surface font-medium">{selectedIds.size} Selected</span>
          <div class="flex gap-4">
            <button
              class="text-primary hover:text-primary"
              aria-label="Share selected"
              onclick={shareSelected}
            >
              <ShareSquareIcon class="h-5 w-5" />
            </button>
            <button
              class="text-error hover:text-error"
              aria-label="Delete selected"
              onclick={() => (showDeleteConfirm = true)}
            >
              <TrashIcon class="h-5 w-5" />
            </button>
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
