<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import MediaThumb from './MediaThumb.svelte';
  import type { MediaPreview } from '@gos/shared/types';
  import { useMedia } from '../host/useMedia';
  import { usePhoneNotification } from '../host/usePhoneNotification';
  import PhotoIcon from './icons/PhotoIcon.svelte';
  import CloseIcon from './icons/CloseIcon.svelte';
  import CheckCircleIcon from './icons/CheckCircleIcon.svelte';
  import Button from './Button.svelte';
  import { focusTrap } from '../lib/focusTrap';
  import { t } from '../i18n';
  import './messages';

  let {
    title = undefined,
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

  // A `$derived` fallback rather than a prop default, so the heading follows the locale.
  const heading = $derived(title ?? $t('ui.selectPhoto'));

  const { media, fullMedia } = useMedia();
  const { toast } = usePhoneNotification();

  const isSelected = (id: number) => selectedIds.includes(id);
  const selectedCount = $derived(selectedIds.length);

  /** The row whose bytes are in flight, so its tile can say so and refuse a second tap. */
  let picking = $state<number | null>(null);

  /**
   * Single-select hands over the **bytes**, so it has to fetch them.
   *
   * This used to read `photo.data` straight off the list row, which worked only because the
   * list carried every column. It does not any more (MICA-110): `data` is `private` in the
   * projection, so a row arrives with a thumbnail and nothing else and this passed
   * `undefined` — clearing the avatar it was asked to set. Same-session captures hid it,
   * because `createMedia` echoes back what the client sent; a reload made it universal.
   *
   * A thumbnail would be the wrong thing to hand over even when one is present. An avatar is
   * displayed far larger than a 123px tile, and `fullMedia` is the one call that answers with
   * the original — a facet member rather than a method on the store, because the store a
   * sandboxed app gets is a `Readable` with no methods on it.
   *
   * Multi-select is unaffected and deliberately still passes the row: an attachment is
   * referenced by id and drawn from its thumbnail, so it wants no bytes at all.
   */
  const pick = async (photo: MediaPreview) => {
    if (picking !== null) return;
    picking = photo.id;
    try {
      const full = await fullMedia(photo.id);
      if (!full?.data) throw new Error('That photo has no image data.');
      onselect?.(full.data);
    } catch (e) {
      console.warn(`Photo ${photo.id} could not be loaded for selection.`, e);
      toast.show({
        type: 'error',
        app: 'media',
        message: $t('ui.photoLoadFailed')
      });
    } finally {
      picking = null;
    }
  };

  let dialogRef = $state<HTMLElement | null>(null);

  /** Announce the picker on open, and start Tab inside it — see `ConfirmDialog`. */
  $effect(() => {
    dialogRef?.focus({ preventScroll: true });
  });
</script>

<!-- `inset-0` covers the app that opened it, but covering is not hiding: the screen
     underneath keeps its buttons in the tab order. Hence the trap. -->
<div
  bind:this={dialogRef}
  use:focusTrap
  role="dialog"
  aria-modal="true"
  aria-label={heading}
  tabindex="-1"
  class="animate-in fade-in bg-surface-container-high duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col outline-none backdrop-blur-md"
>
  <!-- Header -->
  <div class="border-outline-variant flex items-center justify-between border-b p-4">
    <h3 class="text-on-surface text-body-large flex items-center gap-2">
      <PhotoIcon class="text-primary size-icon-md" />
      {heading}
    </h3>
    <button
      class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard rounded-full p-1 transition-colors"
      onclick={onclose}
      aria-label={$t('ui.closePhotoPicker')}
    >
      <CloseIcon class="size-icon-md" />
    </button>
  </div>

  <!-- Photo Grid -->
  <div class="grid flex-1 grid-cols-3 content-start gap-2 overflow-y-auto p-3">
    {#each $media as photo (photo.id)}
      {#if multiSelect}
        {@const selected = isSelected(photo.id)}
        <button
          type="button"
          class="group bg-surface-container relative aspect-square overflow-hidden rounded-box border transition-all {selected
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
          disabled={picking !== null}
          class="group border-outline-variant bg-surface-container hover:border-primary duration-short ease-standard relative aspect-square overflow-hidden rounded-box border transition-all {picking ===
          photo.id
            ? 'opacity-50'
            : ''}"
          onclick={() => pick(photo)}
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
        {$t('ui.noPhotos')}
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
          {$t('ui.clearSelection')}
        </Button>
      {/if}
      <Button class="text-body-small flex-1 py-2" onclick={onclose}>
        {$t('ui.done')}
        {selectedCount > 0 ? `(${selectedCount})` : ''}
      </Button>
    {:else}
      {#if showRemove}
        <Button variant="danger" class="text-body-small flex-1 py-2" onclick={() => onselect?.('')}>
          {$t('ui.removePhoto')}
        </Button>
      {/if}
      <Button variant="secondary" class="text-body-small flex-1 py-2" onclick={onclose}
        >{$t('ui.cancel')}</Button
      >
    {/if}
  </div>
</div>
