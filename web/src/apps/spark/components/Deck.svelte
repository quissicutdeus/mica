<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { CheckIcon, CloseIcon, EmptyState, Skeleton, useLocale } from '@mica/sdk';
  import type { SparkCard } from '@mica/shared/types';
  import ProfileCard from './ProfileCard.svelte';

  /**
   * One card at a time, and two buttons.
   *
   * Nothing about whether they have swiped on you: a like that is not yet mutual looks exactly
   * like a pass here, and the deck simply moves on.
   */
  let {
    card,
    loaded,
    busy = false,
    onswipe,
    onreport
  }: {
    card: SparkCard | undefined;
    loaded: boolean;
    busy?: boolean;
    onswipe: (card: SparkCard, verdict: 'like' | 'pass') => void;
    onreport: (card: SparkCard) => void;
  } = $props();

  const { t } = useLocale();

  const name = $derived(card?.display_name || $t('spark.someone'));
</script>

<!-- `pb-20` clears the nav and the home indicator under it. -->
<div class="min-h-0 flex-1 overflow-y-auto pb-20" data-testid="spark-deck">
  {#if !loaded}
    <div class="p-4"><Skeleton count={1} height="h-64" /></div>
  {:else if !card}
    <div class="flex min-h-0 flex-1 flex-col" data-testid="spark-deck-empty">
      <EmptyState title={$t('spark.deckEmpty')} description={$t('spark.deckEmptyHint')} />
    </div>
  {:else}
    {#key card.id}
      <ProfileCard {card} {onreport} />

      <div class="flex justify-center gap-6 px-4 pb-4">
        <button
          type="button"
          class="border-outline-variant text-on-surface hover:bg-surface-container-high duration-short ease-standard flex h-16 w-16 cursor-pointer items-center justify-center rounded-full border transition-colors disabled:opacity-50"
          aria-label={$t('spark.passName', { name })}
          title={$t('spark.pass')}
          disabled={busy}
          onclick={() => onswipe(card, 'pass')}
          data-testid="spark-pass"
        >
          <CloseIcon class="size-icon-md" />
        </button>
        <button
          type="button"
          class="bg-primary text-on-primary shadow-elevation-2 duration-short ease-standard flex h-16 w-16 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-105 disabled:opacity-50"
          aria-label={$t('spark.likeName', { name })}
          title={$t('spark.like')}
          disabled={busy}
          onclick={() => onswipe(card, 'like')}
          data-testid="spark-like"
        >
          <CheckIcon class="size-icon-md" />
        </button>
      </div>
    {/key}
  {/if}
</div>
