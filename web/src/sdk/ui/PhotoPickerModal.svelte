<script lang="ts">
  import MediaThumb from './MediaThumb.svelte';
  import { photos } from '../../services/photos';
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
  class="animate-in fade-in bg-surface-container-high absolute inset-0 z-30 flex flex-col backdrop-blur-md duration-200"
>
  <!-- Header -->
  <div class="border-outline-variant flex items-center justify-between border-b p-4">
    <h3 class="text-on-surface flex items-center gap-2 text-base font-semibold">
      <PhotoIcon class="text-primary h-5 w-5" />
      {title}
    </h3>
    <button
      class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface rounded-full p-1 transition-colors"
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
          class="group bg-surface-container relative aspect-square overflow-hidden rounded-xl border transition-all {selected
            ? 'ring-primary border-primary ring-2'
            : 'border-outline-variant hover:border-outline'}"
          onclick={() => onmultichange?.(photo.id, photo.data)}
        >
          <MediaThumb item={photo} />
          {#if selected}
            <div class="bg-primary absolute top-1.5 right-1.5 rounded-full p-0.5 shadow-md">
              <CheckCircleIcon class="text-on-primary h-4 w-4" />
            </div>
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="group border-outline-variant bg-surface-container hover:border-primary relative aspect-square overflow-hidden rounded-xl border transition-all"
          onclick={() => onselect?.(photo.data)}
        >
          <MediaThumb item={photo} />
        </button>
      {/if}
    {/each}

    {#if $photos.length === 0}
      <div
        class="text-on-surface-variant col-span-3 flex flex-col items-center py-12 text-center text-sm"
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
          class="flex-1 py-2 text-xs"
          onclick={() => {
            // Clear all — parent handles resetting the array
            for (const id of [...selectedIds]) {
              const photo = $photos.find((p) => p.id === id);
              if (photo) onmultichange?.(photo.id, photo.data);
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
