<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, CloseIcon, MediaThumb, PhotoIcon, PhotoPickerModal, useLocale } from '@mica/sdk';
  import type { MediaPreview, SparkProfile } from '@mica/shared/types';
  import { LIMITS, type SparkProfileInput } from '../store';

  /**
   * Opt-in and edit, one form, because the server has one action for both (`save`).
   *
   * No `<form>`: an add-on's frame has no `allow-forms`, so a submit never fires there. Save is a
   * button, and Enter in a one-line field saves too, skipped mid-composition.
   *
   * Every field is seeded once at mount (`untrack`), Glimpse's reasoning: tracking the prop would
   * let a refresh overwrite what the player is typing.
   */
  let {
    profile = null,
    busy = false,
    onsave,
    oncancel,
    ondelete
  }: {
    profile?: SparkProfile | null;
    busy?: boolean;
    onsave: (input: SparkProfileInput) => void;
    /** Absent on first opt-in: there is nothing to go back to. */
    oncancel?: () => void;
    /** Absent on first opt-in: there is nothing to delete. */
    ondelete?: () => void;
  } = $props();

  const { t } = useLocale();

  type Picked = { photo_id: number; media: Omit<MediaPreview, 'id'> };

  /** The held profile's photos, paired with the gallery ids behind them, in order. */
  const seedPhotos = (from: SparkProfile | null): Picked[] =>
    (from?.photo_ids ?? []).flatMap((photoId, n) => {
      const photo = from?.photos[n];
      return photo ? [{ photo_id: photoId, media: photo.media }] : [];
    });

  let name = $state(untrack(() => profile?.display_name ?? ''));
  let age = $state<number | null>(untrack(() => profile?.age ?? null));
  let bio = $state(untrack(() => profile?.bio ?? ''));
  let lookingFor = $state(untrack(() => profile?.looking_for ?? ''));
  let photos = $state<Picked[]>(untrack(() => seedPhotos(profile)));
  let showPicker = $state(false);

  const ageValid = $derived(
    typeof age === 'number' && Number.isInteger(age) && age >= LIMITS.minAge && age <= LIMITS.maxAge
  );
  const canSave = $derived(
    !busy &&
      name.trim().length > 0 &&
      ageValid &&
      photos.length >= LIMITS.minPhotos &&
      photos.length <= LIMITS.maxPhotos
  );

  const save = () => {
    if (!canSave || age === null) return;
    onsave({
      display_name: name.trim(),
      age,
      bio: bio.trim() || null,
      looking_for: lookingFor.trim() || null,
      photos: photos.map((p) => ({ photo_id: p.photo_id }))
    });
  };

  const saveOnEnter = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    save();
  };
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="spark-editor">
  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    <h2 class="text-on-surface mb-1 text-lg font-bold">
      {profile ? $t('spark.editTitle') : $t('spark.createTitle')}
    </h2>
    <p class="text-on-surface-variant text-body-small mb-4">{$t('spark.createHint')}</p>

    <p class="text-on-surface-variant text-body-small mb-1">{$t('spark.photos')}</p>
    <div class="mb-1 grid grid-cols-4 gap-1.5" data-testid="spark-editor-photos">
      {#each photos as photo (photo.photo_id)}
        <div class="bg-surface-container relative aspect-square overflow-hidden rounded-box">
          <MediaThumb
            item={{ ...photo.media, id: photo.photo_id }}
            alt={$t('spark.selectedPhoto')}
          />
          <button
            type="button"
            class="text-on-surface bg-media-overlay absolute top-0 right-0 cursor-pointer rounded-bl-lg p-0.5 hover:bg-black"
            onclick={() => (photos = photos.filter((p) => p.photo_id !== photo.photo_id))}
            aria-label={$t('spark.removePhoto')}
          >
            <CloseIcon class="h-3 w-3" />
          </button>
        </div>
      {/each}
      {#if photos.length < LIMITS.maxPhotos}
        <button
          type="button"
          class="border-outline-variant text-on-surface-variant hover:bg-surface-container hover:text-primary duration-short ease-standard flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-box border border-dashed transition-colors"
          onclick={() => (showPicker = true)}
          aria-label={$t('spark.addPhoto')}
          data-testid="spark-add-photo"
        >
          <PhotoIcon class="size-icon-md" />
          <span class="text-label-small">{$t('spark.addPhoto')}</span>
        </button>
      {/if}
    </div>
    <p class="text-on-surface-variant text-body-small mb-4">{$t('spark.photosHint')}</p>

    <label class="text-on-surface-variant text-body-small mb-1 block" for="spark-name">
      {$t('spark.name')}
    </label>
    <input
      id="spark-name"
      bind:value={name}
      maxlength={LIMITS.name}
      placeholder={$t('spark.namePlaceholder')}
      onkeydown={saveOnEnter}
      class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full rounded-box px-3 py-2.5 focus:outline-none mb-4"
      data-testid="spark-name"
    />

    <label class="text-on-surface-variant text-body-small mb-1 block" for="spark-age">
      {$t('spark.age')}
    </label>
    <input
      id="spark-age"
      type="number"
      inputmode="numeric"
      min={LIMITS.minAge}
      max={LIMITS.maxAge}
      bind:value={age}
      onkeydown={saveOnEnter}
      class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full rounded-box px-3 py-2.5 focus:outline-none"
      data-testid="spark-age"
    />
    <!-- The quiet line: an in-character number, and the server holds it to 18 and over. -->
    <p
      class="text-body-small mt-1 mb-4"
      class:text-on-surface-variant={ageValid || age === null}
      class:text-error={!ageValid && age !== null}
      data-testid="spark-age-hint"
    >
      {!ageValid && age !== null ? $t('spark.ageInvalid') : $t('spark.ageHint')}
    </p>

    <label class="text-on-surface-variant text-body-small mb-1 block" for="spark-looking-for">
      {$t('spark.lookingFor')}
    </label>
    <input
      id="spark-looking-for"
      bind:value={lookingFor}
      maxlength={LIMITS.lookingFor}
      placeholder={$t('spark.lookingForPlaceholder')}
      onkeydown={saveOnEnter}
      class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full rounded-box px-3 py-2.5 focus:outline-none mb-4"
      data-testid="spark-looking-for"
    />

    <label class="text-on-surface-variant text-body-small mb-1 block" for="spark-bio">
      {$t('spark.bio')}
    </label>
    <textarea
      id="spark-bio"
      bind:value={bio}
      maxlength={LIMITS.bio}
      rows="4"
      placeholder={$t('spark.bioPlaceholder')}
      class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full resize-none rounded-box p-2.5 focus:outline-none"
      data-testid="spark-bio"></textarea>
    <p class="text-on-surface-variant text-body-small mt-1 text-right">
      {LIMITS.bio - bio.length}
    </p>

    {#if ondelete}
      <button
        type="button"
        class="text-error text-label-large mt-4 cursor-pointer py-2"
        disabled={busy}
        onclick={ondelete}
        data-testid="spark-delete-profile"
      >
        {$t('spark.deleteProfile')}
      </button>
    {/if}
  </div>

  <!-- Bottom-anchored, so it clears the home indicator. -->
  <div class="border-outline-variant pb-home-indicator border-t">
    <div class="flex gap-2 p-3">
      {#if oncancel}
        <Button variant="secondary" class="flex-1" disabled={busy} onclick={oncancel}>
          {$t('spark.cancel')}
        </Button>
      {/if}
      <Button class="flex-1" disabled={!canSave} onclick={save} data-testid="spark-save">
        {busy ? '…' : profile ? $t('spark.save') : $t('spark.create')}
      </Button>
    </div>
  </div>
</div>

{#if showPicker}
  <PhotoPickerModal
    title={$t('spark.selectPhotos')}
    multiSelect={true}
    selectedIds={photos.map((p) => p.photo_id)}
    onmultichange={(photoId: number, media: MediaPreview) => {
      if (photos.some((p) => p.photo_id === photoId)) {
        photos = photos.filter((p) => p.photo_id !== photoId);
      } else if (photos.length < LIMITS.maxPhotos) {
        // The server refuses more than four outright rather than truncating.
        photos = [...photos, { photo_id: photoId, media }];
      }
    }}
    onclose={() => (showPicker = false)}
  />
{/if}
