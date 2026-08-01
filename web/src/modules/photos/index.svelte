<script lang="ts">
  import {
    ConfirmDialog,
    EmptyState,
    Screen,
    CheckIcon,
    EmptyPhotoIcon,
    ShareSquareIcon,
    TrashIcon
  } from '@gphone/sdk';
  import { useCamera, useKeybinds, useNavigation, onAppMount, ReportDialog } from '../../sdk';
  import type { Photo } from '@shared/types';
  import { fade } from 'svelte/transition';

  let { onback, initialPhoto, initialPhotoId } = $props<{
    onback?: () => void;
    initialPhoto?: Photo;
    initialPhotoId?: number;
  }>();

  const { photosStore, deletePhoto } = useCamera();
  const { consumeDeepLink } = useNavigation();
  const { onKeybind } = useKeybinds();

  let selectedPhoto: Photo | null = $state(null);
  let isSelectionMode = $state(false);
  let selectedIds = $state<Set<number>>(new Set());
  let isLoading = $state(false);
  let showDeleteConfirm = $state(false);
  let reporting = $state(false);

  onAppMount(() => {
    void photosStore.load();
  });

  /**
   * Open the photo a deep link asked for, exactly once.
   *
   * An `$effect` rather than mount-time work, because the app stays resident and mount
   * runs only once — a second tap on the camera thumbnail would otherwise be ignored.
   *
   * Consuming the props is what makes the back button work. Without it the prop is
   * still set when `goBack` clears `selectedPhoto`, this effect re-runs and immediately
   * reopens the same picture.
   */
  $effect(() => {
    if (initialPhoto) {
      selectedPhoto = initialPhoto;
      consumeDeepLink('photos');
      return;
    }
    if (initialPhotoId) {
      // Read the store reactively: on a cold open the photo list has not arrived yet,
      // and the prop must survive until it does.
      const found = $photosStore.find((p) => p.id === initialPhotoId);
      if (found) {
        selectedPhoto = found;
        consumeDeepLink('photos');
      }
    }
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
    isLoading = true;
    try {
      for (const id of Array.from(selectedIds)) {
        await deletePhoto(id);
      }
      selectedIds.clear();
      isSelectionMode = false;
      showDeleteConfirm = false;
    } catch (e) {
      console.error('Failed to delete photos', e);
    } finally {
      isLoading = false;
    }
  };

  const shareSelected = () => {
    // Mock share functionality
    console.log('Sharing photos:', Array.from(selectedIds));
    alert('Photos shared! (Mock)');
    selectedIds.clear();
    isSelectionMode = false;
  };

  const deleteSingle = async () => {
    if (!selectedPhoto) return;
    isLoading = true;
    try {
      await deletePhoto(selectedPhoto.id);
      selectedPhoto = null;
      showDeleteConfirm = false;
    } catch (e) {
      console.error('Failed to delete photo', e);
    } finally {
      isLoading = false;
    }
  };

  /**
   * Backspace steps up one level inside the app before it will leave.
   *
   * Claimed rather than handled raw: the shell owns Backspace, and a local listener
   * would be pre-empted. The handler stack puts this on top while mounted and returns
   * the action to the shell on unmount.
   */
  const goBack = () => {
    if (selectedPhoto) {
      selectedPhoto = null;
    } else {
      onback?.();
    }
  };

  onKeybind('back', () => goBack());
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

<Screen title={selectedPhoto ? 'Photo' : 'Photos'} onback={goBack} actions={headerActions}>
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
          onclick={() => {
            console.log('Share photo', selectedPhoto?.id);
            alert('Photo shared! (Mock)');
          }}
        >
          <ShareSquareIcon class="h-6 w-6" />
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
          {isLoading}
          oncancel={() => (showDeleteConfirm = false)}
          onconfirm={deleteSingle}
        />
      {/if}
    </div>
  {:else}
    <!-- Grid View -->
    <div class="no-scrollbar relative h-full overflow-y-auto bg-gray-900 p-1">
      {#if $photosStore.length === 0}
        <EmptyState title="No photos yet">
          {#snippet icon()}
            <EmptyPhotoIcon class="h-16 w-16" />
          {/snippet}
        </EmptyState>
      {:else}
        <div class="grid grid-cols-3 gap-1">
          {#each $photosStore as photo}
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
          {isLoading}
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
