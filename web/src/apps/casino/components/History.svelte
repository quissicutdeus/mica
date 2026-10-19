<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { EmptyState, Skeleton, formatTime, useLocale } from '@mica/sdk';
  import { history, historyCursor, historyLoaded, loadMoreHistory } from '../store';
  import { formatMultiplier } from '../rules';

  const { t } = useLocale();

  let loadingMore = $state(false);
  const more = async () => {
    loadingMore = true;
    await loadMoreHistory();
    loadingMore = false;
  };
</script>

<div
  data-testid="casino-history"
  class="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-home-indicator"
>
  {#if !$historyLoaded}
    <Skeleton count={4} height="h-14" />
  {:else if $history.length === 0}
    <EmptyState
      title={$t('casino.historyEmptyTitle')}
      description={$t('casino.historyEmptyDescription')}
    />
  {:else}
    <ul class="divide-outline-variant divide-y">
      {#each $history as round (round.id)}
        {@const net = round.payout - round.stake}
        {@const inPlay = round.status === 'active'}
        <li data-testid="casino-history-row" class="flex items-center justify-between gap-3 py-3">
          <div class="min-w-0">
            <p class="text-body-large text-on-surface truncate">
              {#if round.game === 'roulette'}
                {round.number === null
                  ? $t('casino.historyRoulette')
                  : $t('casino.historyNumber', { number: round.number })}
              {:else if round.multiplier !== null}
                {$t('casino.historyCashed', { multiplier: formatMultiplier(round.multiplier) })}
              {:else if round.crash_point !== null}
                {$t('casino.historyBusted', { multiplier: formatMultiplier(round.crash_point) })}
              {:else}
                {$t('casino.historyCrash')}
              {/if}
            </p>
            <p class="text-body-small text-on-surface-variant">
              {$t('casino.historyStake', { amount: round.stake })} · {formatTime(round.created_at)}
            </p>
          </div>
          <!-- A crash round still in play has paid nothing yet, which is not the same as lost. -->
          <p
            class="text-title-medium shrink-0 {inPlay
              ? 'text-on-surface-variant'
              : net > 0
                ? 'text-green-400'
                : net < 0
                  ? 'text-error'
                  : 'text-on-surface-variant'}"
          >
            {inPlay
              ? $t('casino.historyInPlay')
              : net > 0
                ? $t('casino.won', { amount: net })
                : net < 0
                  ? $t('casino.lost', { amount: -net })
                  : $t('casino.brokeEven')}
          </p>
        </li>
      {/each}
    </ul>
    {#if $historyCursor !== null}
      <button
        type="button"
        onclick={more}
        disabled={loadingMore}
        class="bg-surface-container-high text-on-surface text-label-large disabled:cursor-not-allowed mt-3 w-full rounded-full py-3"
      >
        {$t('casino.loadMore')}
      </button>
    {/if}
  {/if}
</div>
