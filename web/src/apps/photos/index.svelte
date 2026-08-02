<script lang="ts">
  import {
    CheckIcon,
    ConfirmDialog,
    EmptyPhotoIcon,
    EmptyState,
    FlagIcon,
    ReportDialog,
    Screen,
    Skeleton,
    ShareSquareIcon,
    TrashIcon,
    onAppForeground,
    useAppAction,
    useAppLevels,
    useDeepLink,
    usePhotos,
    usePhoneNotification
  } from '@gphone/sdk';
  import type { Photo } from '@shared/types';
  import { fade } from 'svelte/transition';

  let { onback, initialPhoto, initialPhotoId } = $props<{
    onback?: () => void;
    initialPhoto?: Photo;
    initialPhotoId?: number;
  }>();

  const { photos, deletePhoto } = usePhotos();
  const photosLoaded = photos.loaded;
  const { busy, run } = useAppAction();
  const { toast } = usePhoneNotification();

  let selectedPhoto: Photo | null = $state(null);
  let isSelectionMode = $state(false);
  let selectedIds = $state<Set<number>>(new Set());
  let showDeleteConfirm = $state(false);
  let reporting = $state(false);

  onAppForeground('photos', () => {
    void photos.load();
  });

  useDeepLink('photos', () => {
    if (initialPhoto) {
      selectedPhoto = initialPhoto;
      return true;
    }
    if (!initialPhotoId) return false;

    // Read the store reactively: on a cold open the photo list has not arrived yet, and
    // the link must survive until it does.
    const found = $photos.find((p) => p.id === initialPhotoId);
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

  const handlePhotoClick = (photo: Photo) => {
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
    toast.show({ type: 'info', message: 'Sharing photos is not implemented yet' });
    selectedIds.clear();
    isSelectionMode = false;
  };

  const deleteSingle = async () => {
    if (!selectedPhoto) return;
    if (!(await run(() => deletePhoto(selectedPhoto!.id), { success: 'Photo deleted' }))) return;

    selectedPhoto = null;
    showDeleteConfirm = false;
  };

  const app = useAppLevels({
    title: 'Photos',
    onback: () => onback?.(),
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
      class="ml-auto rounded-full p-2 font-semibold text-blue-400 transition-colors hover:bg-gray-700"
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
        <!-- svelte-ignore a11y_missing_attribute -->
        <img src={selectedPhoto.image} class="h-full w-full object-contain" />
      </div>

      <div class="flex justify-between border-t border-gray-800 bg-black/80 p-4 pb-8 backdrop-blur">
        <button
          class="p-2 text-blue-400 transition-colors hover:text-blue-300"
          aria-label="Share photo"
          onclick={() =>
            toast.show({ type: 'info', message: 'Sharing photos is not implemented yet' })}
        >
          <ShareSquareIcon class="h-6 w-6" />
        </button>
        <button
          class="p-2 text-gray-400 transition-colors hover:text-rose-400"
          aria-label="Report photo"
          onclick={() => (reporting = true)}
        >
          <FlagIcon class="h-6 w-6" />
        </button>
        <button
          class="p-2 text-red-500 transition-colors hover:text-red-400"
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
    <div class="no-scrollbar relative h-full overflow-y-auto bg-gray-900 p-1">
      {#if !$photosLoaded}
        <Skeleton count={4} height="h-24" rounded="rounded-none" />
      {:else if $photos.length === 0}
        <EmptyState title="No photos yet">
          {#snippet icon()}
            <EmptyPhotoIcon class="h-16 w-16" />
          {/snippet}
        </EmptyState>
      {:else}
        <div class="grid grid-cols-3 gap-1">
          {#each $photos as photo}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="group relative aspect-square cursor-pointer bg-gray-800"
              onclick={() => handlePhotoClick(photo)}
            >
              <img
                src={photo.image}
                alt="Capture {photo.id}"
                class="h-full w-full object-cover transition-opacity {isSelectionMode &&
                selectedIds.has(photo.id)
                  ? 'opacity-50'
                  : 'group-hover:opacity-80'}"
              />
              {#if isSelectionMode}
                <div
                  class="absolute right-2 bottom-2 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white {selectedIds.has(
                    photo.id
                  )
                    ? 'bg-blue-500'
                    : 'bg-black/20 backdrop-blur-sm'}"
                >
                  {#if selectedIds.has(photo.id)}
                    <CheckIcon class="h-4 w-4 text-white" />
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if isSelectionMode && selectedIds.size > 0}
        <div
          class="absolute right-4 bottom-4 left-4 flex items-center justify-between rounded-2xl border border-gray-700 bg-gray-800/90 p-4 shadow-2xl backdrop-blur-md"
          transition:fade
        >
          <span class="font-medium text-white">{selectedIds.size} Selected</span>
          <div class="flex gap-4">
            <button
              class="text-blue-400 hover:text-blue-300"
              aria-label="Share selected"
              onclick={shareSelected}
            >
              <ShareSquareIcon class="h-5 w-5" />
            </button>
            <button
              class="text-red-500 hover:text-red-400"
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
    targetTable="gphone_photos"
    targetId={selectedPhoto.id}
    onclose={() => (reporting = false)}
  />
{/if}
