<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { MAX_ATTACHMENTS } from '@mica/shared/attachments';
  import { untrack } from 'svelte';
  import { Button, CloseIcon, MediaThumb, PhotoIcon, PhotoPickerModal, useLocale } from '@mica/sdk';
  import type { MediaPreview } from '@mica/shared/types';

  /** `mica_glimpse.caption` is a varchar(500); the server enforces it from the same declaration. */
  const LIMIT = 500;

  /**
   * A new post — photos from the gallery, then a caption — or, with `editing`, the caption of one
   * already posted.
   *
   * Editing offers no photos: there is no route to change what a post carries once it exists,
   * and the edit window (`mica_glimpse_edit_window`) is framed as a typo fix, not a re-post.
   * A new post needs at least one photo, the rule `create` enforces — a photo app's post with no
   * photo is not one.
   */
  let {
    handle,
    editing = false,
    initial = '',
    busy = false,
    onsubmit,
    oncancel
  }: {
    handle?: string;
    editing?: boolean;
    initial?: string;
    busy?: boolean;
    onsubmit: (caption: string, attachments: { photo_id: number }[]) => void;
    oncancel: () => void;
  } = $props();

  const { t } = useLocale();

  /** Seeded once at mount; tracking the prop would overwrite what the player is typing. */
  let caption = $state(untrack(() => initial));
  let photos = $state<{ photo_id: number; media: MediaPreview }[]>([]);
  let showPicker = $state(false);

  const remaining = $derived(LIMIT - caption.length);
  const canSubmit = $derived(
    !busy && remaining >= 0 && (editing ? caption.trim() !== initial.trim() : photos.length > 0)
  );

  const submit = () => {
    if (!canSubmit) return;
    onsubmit(
      caption.trim(),
      photos.map((p) => ({ photo_id: p.photo_id }))
    );
  };
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    <h3 class="text-on-surface mb-1 text-lg font-bold">
      {editing ? $t('glimpse.editCaption') : $t('glimpse.newPost')}
    </h3>
    {#if handle}
      <p class="text-on-surface-variant text-body-small mb-3">
        {$t('glimpse.postingAs')} <span class="text-primary">@{handle}</span>
      </p>
    {/if}

    {#if !editing}
      <div class="mb-3 grid grid-cols-3 gap-1.5" data-testid="glimpse-composer-photos">
        {#each photos as photo (photo.photo_id)}
          <div class="bg-surface-container relative aspect-square overflow-hidden rounded-box">
            <MediaThumb item={photo.media} alt={$t('glimpse.selectedPhoto')} />
            <button
              type="button"
              class="text-on-surface bg-media-overlay absolute top-0 right-0 cursor-pointer rounded-bl-lg p-0.5 hover:bg-black"
              onclick={() => (photos = photos.filter((p) => p.photo_id !== photo.photo_id))}
              aria-label={$t('glimpse.removePhoto')}
            >
              <CloseIcon class="h-3 w-3" />
            </button>
          </div>
        {/each}
        {#if photos.length < MAX_ATTACHMENTS}
          <button
            type="button"
            class="border-outline-variant text-on-surface-variant hover:bg-surface-container hover:text-primary duration-short ease-standard flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-box border border-dashed transition-colors"
            onclick={() => (showPicker = true)}
            aria-label={$t('glimpse.addPhotos')}
          >
            <PhotoIcon class="size-icon-md" />
            <span class="text-label-small">{$t('glimpse.addPhotos')}</span>
          </button>
        {/if}
      </div>
    {/if}

    <label class="text-on-surface-variant text-body-small mb-1 block" for="glimpse-caption">
      {$t('glimpse.caption')}
    </label>
    <textarea
      id="glimpse-caption"
      bind:value={caption}
      maxlength={LIMIT}
      rows="4"
      placeholder={$t('glimpse.captionPlaceholder')}
      class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full resize-none rounded-box p-2.5 focus:outline-none"
    ></textarea>
    <p
      class="text-body-small mt-1 text-right"
      class:text-on-surface-variant={remaining > 50}
      class:text-amber-400={remaining <= 50}
    >
      {remaining}
    </p>
  </div>

  <!-- Bottom-anchored, so it clears the home indicator. -->
  <div class="border-outline-variant pb-home-indicator border-t">
    <div class="flex gap-2 p-3">
      <Button variant="secondary" class="flex-1" disabled={busy} onclick={oncancel}>
        {$t('glimpse.cancel')}
      </Button>
      <Button class="flex-1" disabled={!canSubmit} onclick={submit}>
        {busy ? '…' : editing ? $t('glimpse.save') : $t('glimpse.share')}
      </Button>
    </div>
  </div>
</div>

{#if showPicker}
  <PhotoPickerModal
    title={$t('glimpse.selectPhotos')}
    multiSelect={true}
    selectedIds={photos.map((p) => p.photo_id)}
    onmultichange={(photoId: number, media: MediaPreview) => {
      if (photos.some((p) => p.photo_id === photoId)) {
        photos = photos.filter((p) => p.photo_id !== photoId);
      } else if (photos.length < MAX_ATTACHMENTS) {
        // The server refuses an over-cap list outright rather than truncating it.
        photos = [...photos, { photo_id: photoId, media }];
      }
    }}
    onclose={() => (showPicker = false)}
  />
{/if}
