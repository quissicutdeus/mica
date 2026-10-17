<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { ReportButton, useLocale } from '@mica/sdk';
  import type { SparkCard } from '@mica/shared/types';
  import PhotoCarousel from './PhotoCarousel.svelte';

  /**
   * A profile as another player sees it: photos, name and age, what they are looking for, and
   * their bio. Only what its owner wrote — no handle, no other app, nothing about swipes.
   */
  let { card, onreport }: { card: SparkCard; onreport?: (card: SparkCard) => void } = $props();

  const { t } = useLocale();
</script>

<!-- Padding on a wrapper: no margin utility exists on all four sides. -->
<div class="p-4">
  <article
    class="animate-in fade-in duration-medium ease-emphasized overflow-hidden rounded-box bg-surface-container-low shadow-elevation-2"
    data-testid="spark-card"
    data-profile-id={card.id}
  >
    <PhotoCarousel photos={card.photos} />
    <div class="p-4">
      <div class="flex items-start gap-2">
        <h2
          class="text-on-surface text-title-large min-w-0 flex-1 truncate font-semibold"
          data-testid="spark-card-name"
        >
          {$t('spark.nameAge', { name: card.display_name || $t('spark.someone'), age: card.age })}
        </h2>
        {#if onreport}
          <ReportButton subject={$t('spark.profileNoun')} onclick={() => onreport(card)} />
        {/if}
      </div>
      {#if card.looking_for}
        <p class="text-primary text-body-medium mt-1">
          {$t('spark.lookingForLine', { text: card.looking_for })}
        </p>
      {/if}
      {#if card.bio}
        <!-- Another player's text: rendered as text, never as markup. -->
        <p class="text-on-surface-variant text-body-medium mt-2 break-words whitespace-pre-wrap">
          {card.bio}
        </p>
      {/if}
    </div>
  </article>
</div>
