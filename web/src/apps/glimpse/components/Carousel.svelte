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
  import type { GlimpsePost } from '@mica/shared/types';

  /**
   * A post's photos, one at a time, square.
   *
   * Buttons rather than a swipe track: micaOS is driven by a mouse inside a game, and a
   * horizontal scroll-snap strip needs a trackpad or a drag to move at all. One `MediaThumb`
   * is mounted at a time, so a ten-photo post draws one image rather than ten.
   *
   * **A post can arrive with no photos.** Retention removes a photo by dropping the row, and a
   * post keeps its caption when its last one goes (Blabber's behaviour, an owner decision) — so
   * an empty list is a blank square with a placeholder, not a missing card.
   */
  let { attachments }: { attachments: GlimpsePost['attachments'] } = $props();

  const { t } = useLocale();

  let index = $state(0);

  /** Clamped rather than reset: a refresh that drops a photo must not point past the end. */
  const shown = $derived(attachments[Math.min(index, Math.max(0, attachments.length - 1))]);
  const many = $derived(attachments.length > 1);
</script>

<div class="bg-surface-container relative aspect-square w-full overflow-hidden">
  {#if shown}
    <MediaThumb
      item={shown.media}
      fit="cover"
      prefer="original"
      alt={$t('glimpse.photoOf', { n: index + 1, total: attachments.length })}
    />
  {:else}
    <div
      class="text-on-surface-variant flex h-full w-full items-center justify-center"
      aria-label={$t('glimpse.photoUnavailable')}
      role="img"
    >
      <EmptyPhotoIcon class="size-icon-lg" />
    </div>
  {/if}

  {#if many}
    {#if index > 0}
      <button
        type="button"
        class="bg-media-overlay text-white absolute top-1/2 left-2 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full"
        aria-label={$t('glimpse.previousPhoto')}
        onclick={() => (index -= 1)}
      >
        <ChevronLeftIcon class="size-icon-sm" />
      </button>
    {/if}
    {#if index < attachments.length - 1}
      <button
        type="button"
        class="bg-media-overlay text-white absolute top-1/2 right-2 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full"
        aria-label={$t('glimpse.nextPhoto')}
        onclick={() => (index += 1)}
      >
        <ChevronRightIcon class="size-icon-sm" />
      </button>
    {/if}
    <span
      class="bg-media-overlay text-white text-label-small absolute top-2 right-2 rounded-full px-2 py-0.5"
      data-testid="glimpse-carousel-position"
    >
      {index + 1}/{attachments.length}
    </span>
    <div class="absolute inset-x-0 bottom-2 flex justify-center gap-1" aria-hidden="true">
      {#each attachments as attachment, n (attachment.id)}
        <span class="h-2 w-2 rounded-full {n === index ? 'bg-white' : 'bg-white opacity-40'}"
        ></span>
      {/each}
    </div>
  {/if}
</div>
