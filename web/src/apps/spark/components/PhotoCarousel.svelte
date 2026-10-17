<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    ChevronLeftIcon,
    ChevronRightIcon,
    EmptyPhotoIcon,
    MediaThumb,
    useLocale
  } from '@mica/sdk';
  import type { SparkPhoto } from '@mica/shared/types';

  /**
   * A profile's photos, one at a time: Glimpse's carousel. Square, because no portrait ratio
   * exists as a utility.
   *
   * Buttons rather than a swipe track: micaOS is driven by a mouse inside a game, and a drag
   * would also read as the swipe the card's own buttons stand in for. One `MediaThumb` is
   * mounted at a time. A profile can arrive with none left (retention dropped a photo), so an
   * empty list is a placeholder, not a missing card.
   *
   * `SparkPhoto.media` carries no id by design (its id would be the gallery's, which links one
   * player's profiles across apps); `MediaThumb` wants one, so the Spark row id stands in.
   */
  let { photos }: { photos: SparkPhoto[] } = $props();

  const { t } = useLocale();

  let index = $state(0);

  /** Clamped rather than reset: a refresh that drops a photo must not point past the end. */
  const at = $derived(Math.min(index, Math.max(0, photos.length - 1)));
  const shown = $derived(photos[at]);
  const many = $derived(photos.length > 1);
</script>

<div class="bg-surface-container relative aspect-square w-full overflow-hidden">
  {#if shown}
    <MediaThumb
      item={{ ...shown.media, id: shown.id }}
      fit="cover"
      prefer="original"
      alt={$t('spark.photoOf', { n: at + 1, total: photos.length })}
    />
  {:else}
    <div
      class="text-on-surface-variant flex h-full w-full items-center justify-center"
      aria-label={$t('spark.photoUnavailable')}
      role="img"
    >
      <EmptyPhotoIcon class="size-icon-lg" />
    </div>
  {/if}

  {#if many}
    {#if at > 0}
      <button
        type="button"
        class="bg-media-overlay text-white absolute top-1/2 left-2 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full"
        aria-label={$t('spark.previousPhoto')}
        onclick={() => (index = at - 1)}
      >
        <ChevronLeftIcon class="size-icon-sm" />
      </button>
    {/if}
    {#if at < photos.length - 1}
      <button
        type="button"
        class="bg-media-overlay text-white absolute top-1/2 right-2 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full"
        aria-label={$t('spark.nextPhoto')}
        onclick={() => (index = at + 1)}
        data-testid="spark-next-photo"
      >
        <ChevronRightIcon class="size-icon-sm" />
      </button>
    {/if}
    <div class="absolute inset-x-0 top-2 flex justify-center gap-1" aria-hidden="true">
      {#each photos as photo, n (photo.id)}
        <span class="h-1 w-8 rounded-full {n === at ? 'bg-white' : 'bg-white opacity-40'}"></span>
      {/each}
    </div>
  {/if}
</div>
