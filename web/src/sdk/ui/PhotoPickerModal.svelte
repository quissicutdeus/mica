<script lang="ts">
  import MediaThumb from './MediaThumb.svelte';
  import type { MediaPreview } from '@shared/types';
  import { useMedia } from '../host/useMedia';
  import PhotoIcon from './icons/PhotoIcon.svelte';
  import CloseIcon from './icons/CloseIcon.svelte';
  import CheckCircleIcon from './icons/CheckCircleIcon.svelte';
  import Button from './Button.svelte';

  let {
    title = 'Select Photo',
    multiSelect = false,
    selectedIds = [],
    showRemove = false,
    onselect,
    onmultichange,
    onclose
  } = $props<{
    title?: string;
    /** Single-select mode (contacts): fires onselect with image URL */
    multiSelect?: boolean;
    /** Multi-select mode (messages): tracks selected photo IDs */
    selectedIds?: number[];
    /** Show "Remove Photo" button (contacts avatar clear) */
    showRemove?: boolean;
    /** Single-select callback */
    onselect?: (image: string) => void;
    /**
     * Multi-select toggle. Hands over the row rather than its bytes: an attachment has to
     * know whether it is a video or a GIF to draw itself, and a base64 string cannot say.
     */
    onmultichange?: (photoId: number, media: MediaPreview) => void;
    onclose: () => void;
  }>();

  const { media } = useMedia();

  const isSelected = (id: number) => selectedIds.includes(id);
  const selectedCount = $derived(selectedIds.length);
</script>

<div
  class="animate-in fade-in bg-surface-container-high duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col backdrop-blur-md"
>
  <!-- Header -->
  <div class="border-outline-variant flex items-center justify-between border-b p-4">
    <h3 class="text-on-surface text-body-large flex items-center gap-2">
      <PhotoIcon class="text-primary size-icon-md" />
      {title}
    </h3>
    <button
      class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard rounded-full p-1 transition-colors"
      onclick={onclose}
      aria-label="Close photo picker"
    >
      <CloseIcon class="size-icon-md" />
    </button>
  </div>

  <!-- Photo Grid -->
  <div class="grid flex-1 grid-cols-3 content-start gap-2 overflow-y-auto p-3">
    {#each $media as photo}
      {#if multiSelect}
        {@const selected = isSelected(photo.id)}
        <button
          type="button"
          class="group bg-surface-container relative aspect-square overflow-hidden rounded-xl border transition-all {selected
            ? 'ring-primary border-primary ring-2'
            : 'border-outline-variant hover:border-outline'} duration-short ease-standard"
          onclick={() => onmultichange?.(photo.id, photo)}
        >
          <MediaThumb item={photo} />
          {#if selected}
            <div
              class="bg-primary shadow-elevation-2 absolute top-1.5 right-1.5 rounded-full p-0.5"
            >
              <CheckCircleIcon class="text-on-primary size-icon-sm" />
            </div>
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="group border-outline-variant bg-surface-container hover:border-primary duration-short ease-standard relative aspect-square overflow-hidden rounded-xl border transition-all"
          onclick={() => onselect?.(photo.data)}
        >
          <MediaThumb item={photo} />
        </button>
      {/if}
    {/each}

    {#if $media.length === 0}
      <div
        class="text-on-surface-variant text-body-medium col-span-3 flex flex-col items-center py-12 text-center"
      >
        <PhotoIcon class="text-outline mb-2 h-10 w-10" />
        No photos in gallery.
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="border-outline-variant bg-surface flex gap-2 border-t p-3">
    {#if multiSelect}
      {#if selectedCount > 0}
        <Button
          variant="danger"
          class="text-body-small flex-1 py-2"
          onclick={() => {
            // Clear all — parent handles resetting the array
            for (const id of [...selectedIds]) {
              const photo = $media.find((p) => p.id === id);
              if (photo) onmultichange?.(photo.id, photo);
            }
          }}
        >
          Clear Selection
        </Button>
      {/if}
      <Button class="text-body-small flex-1 py-2" onclick={onclose}>
        Done {selectedCount > 0 ? `(${selectedCount})` : ''}
      </Button>
    {:else}
      {#if showRemove}
        <Button variant="danger" class="text-body-small flex-1 py-2" onclick={() => onselect?.('')}>
          Remove Photo
        </Button>
      {/if}
      <Button variant="secondary" class="text-body-small flex-1 py-2" onclick={onclose}
        >Cancel</Button
      >
    {/if}
  </div>
</div>
