<script lang="ts">
  import { photos } from '../store/photos';
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
    /** Multi-select toggle callback */
    onmultichange?: (photoId: number, image: string) => void;
    onclose: () => void;
  }>();

  const isSelected = (id: number) => selectedIds.includes(id);
  const selectedCount = $derived(selectedIds.length);
</script>

<div
  class="animate-in fade-in absolute inset-0 z-30 flex flex-col bg-gray-950/95 backdrop-blur-md duration-200"
>
  <!-- Header -->
  <div class="flex items-center justify-between border-b border-gray-800 p-4">
    <h3 class="flex items-center gap-2 text-base font-semibold text-white">
      <PhotoIcon class="h-5 w-5 text-blue-400" />
      {title}
    </h3>
    <button
      class="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
      onclick={onclose}
      aria-label="Close photo picker"
    >
      <CloseIcon class="h-5 w-5" />
    </button>
  </div>

  <!-- Photo Grid -->
  <div class="grid flex-1 grid-cols-3 content-start gap-2 overflow-y-auto p-3">
    {#each $photos as photo}
      {#if multiSelect}
        {@const selected = isSelected(photo.id)}
        <button
          type="button"
          class="group relative aspect-square overflow-hidden rounded-xl border bg-gray-800 transition-all {selected
            ? 'border-blue-500 ring-2 ring-blue-500/50'
            : 'border-gray-700/50 hover:border-gray-500'}"
          onclick={() => onmultichange?.(photo.id, photo.image)}
        >
          <img
            src={photo.image}
            class="h-full w-full object-cover transition-transform group-hover:scale-105"
            alt=""
          />
          {#if selected}
            <div class="absolute top-1.5 right-1.5 rounded-full bg-blue-600 p-0.5 shadow-md">
              <CheckCircleIcon class="h-4 w-4 text-white" />
            </div>
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="group relative aspect-square overflow-hidden rounded-xl border border-gray-700/50 bg-gray-800 transition-all hover:border-blue-500"
          onclick={() => onselect?.(photo.image)}
        >
          <img
            src={photo.image}
            class="h-full w-full object-cover transition-transform group-hover:scale-105"
            alt=""
          />
        </button>
      {/if}
    {/each}

    {#if $photos.length === 0}
      <div class="col-span-3 flex flex-col items-center py-12 text-center text-sm text-gray-400">
        <PhotoIcon class="mb-2 h-10 w-10 text-gray-600" />
        No photos in gallery.
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="flex gap-2 border-t border-gray-800 bg-gray-900 p-3">
    {#if multiSelect}
      {#if selectedCount > 0}
        <Button
          variant="danger"
          class="flex-1 py-2 text-xs"
          onclick={() => {
            // Clear all — parent handles resetting the array
            for (const id of [...selectedIds]) {
              const photo = $photos.find((p) => p.id === id);
              if (photo) onmultichange?.(photo.id, photo.image);
            }
          }}
        >
          Clear Selection
        </Button>
      {/if}
      <Button class="flex-1 py-2 text-xs" onclick={onclose}>
        Done {selectedCount > 0 ? `(${selectedCount})` : ''}
      </Button>
    {:else}
      {#if showRemove}
        <Button variant="danger" class="flex-1 py-2 text-xs" onclick={() => onselect?.('')}>
          Remove Photo
        </Button>
      {/if}
      <Button variant="secondary" class="flex-1 py-2 text-xs" onclick={onclose}>Cancel</Button>
    {/if}
  </div>
</div>
