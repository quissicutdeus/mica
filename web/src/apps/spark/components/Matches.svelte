<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { EmptyState, MediaThumb, Skeleton, formatDate, useLocale } from '@mica/sdk';
  import type { SparkMatch } from '@mica/shared/types';
  import type { InboxRow } from '../store';

  /**
   * Every match, with the last line of its thread and an unread count, most recent first. A
   * match with no message yet says so, which is the nudge to send the first one.
   */
  let {
    rows,
    loaded,
    myAccountId,
    onopen
  }: {
    rows: InboxRow[];
    loaded: boolean;
    myAccountId: number | null;
    onopen: (match: SparkMatch) => void;
  } = $props();

  const { t } = useLocale();
</script>

<!-- `pb-20` clears the nav and the home indicator under it. -->
<div class="min-h-0 flex-1 overflow-y-auto pb-20" data-testid="spark-matches">
  {#if !loaded}
    <div class="p-4"><Skeleton count={3} height="h-16" /></div>
  {:else if rows.length === 0}
    <div class="flex min-h-0 flex-1 flex-col">
      <EmptyState title={$t('spark.noMatches')} description={$t('spark.noMatchesHint')} />
    </div>
  {:else}
    {#each rows as row (row.match.id)}
      {@const card = row.match.profile}
      {@const photo = card.photos[0]}
      <button
        type="button"
        class="border-outline-variant hover:bg-surface-container duration-short ease-standard flex w-full cursor-pointer items-center gap-3 border-b px-4 py-3 text-left transition-colors"
        onclick={() => onopen(row.match)}
        data-testid="spark-match"
        data-match-id={row.match.id}
      >
        <div class="bg-surface-container h-12 w-12 shrink-0 overflow-hidden rounded-full">
          {#if photo}
            <MediaThumb item={{ ...photo.media, id: photo.id }} fit="cover" alt="" />
          {/if}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-on-surface text-body-medium min-w-0 flex-1 truncate font-semibold">
              {card.display_name || $t('spark.someone')}
            </span>
            {#if row.last}
              <span class="text-on-surface-variant text-label-small shrink-0">
                {formatDate(row.last.created_at)}
              </span>
            {/if}
          </div>
          <p
            class="text-body-small truncate"
            class:text-on-surface={row.unread > 0}
            class:text-on-surface-variant={row.unread === 0}
          >
            {#if row.last}
              {row.last.from_account === myAccountId ? '↪ ' : ''}{row.last.body}
            {:else}
              {$t('spark.sayHi')}
            {/if}
          </p>
        </div>
        {#if row.unread > 0}
          <span
            class="bg-primary-container text-on-primary-container text-label-small shrink-0 rounded-full px-2 py-0.5"
            aria-label={$t('spark.unread', { count: row.unread })}
            data-testid="spark-match-unread"
          >
            {row.unread}
          </span>
        {/if}
      </button>
    {/each}
  {/if}
</div>
