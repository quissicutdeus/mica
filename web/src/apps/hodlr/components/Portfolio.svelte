<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { EmptyState, Skeleton, onAppForeground, useLocale } from '@gos/sdk';
  import { useHodlr, buyPriceOf, sellPriceOf } from '../store';
  import Chart from './Chart.svelte';

  let { onbuy, onsell }: { onbuy: () => void; onsell: () => void } = $props();

  const { priceStore, portfolioStore, loadPrice, loadPortfolio } = useHodlr();
  const { t } = useLocale();

  let loaded = $state(false);

  /** Buy and sell are genuinely different numbers once a spread exists (MICA-147/149). */
  const buyPrice = $derived(buyPriceOf($priceStore));
  const sellPrice = $derived(sellPriceOf($priceStore));

  /**
   * The market refuses every trade until it has restored its price after a restart
   * (MICA-130), and while it is closed the server sends no quote at all. Saying so is the
   * point: an unlabelled `$0` reads as a broken app, and the old behaviour — quoting the
   * opening constant with total confidence and then refusing to trade at it — was worse
   * still. The chart is unaffected and keeps drawing; only the live quote is missing.
   */
  const open = $derived($priceStore.ready);

  const refresh = async () => {
    await Promise.all([loadPrice(), loadPortfolio()]);
    loaded = true;
  };

  onMount(() => {
    void refresh();
  });

  // Every visit, not once per session — apps stay resident (AGENTS.md §11).
  onAppForeground('hodlr', () => {
    void refresh();
  });
</script>

<div class="flex flex-col gap-4 p-4">
  {#if !loaded}
    <Skeleton count={3} height="h-16" />
  {:else}
    <div class="bg-surface-container rounded-box p-4">
      <p class="text-on-surface-variant text-body-small">{$t('hodlr.price')}</p>
      {#if open}
        <p class="text-on-surface text-title-large">${$priceStore.current}</p>
        <!-- Buy and sell, side by side rather than folded into one number — a spread
             means they can genuinely differ (MICA-147/MICA-149), and showing only the
             mid/reference price here would leave Trade's own quote as the first time a
             player learns which one they actually pay or receive. -->
        <div class="mt-2 flex gap-4">
          <div>
            <p class="text-on-surface-variant text-body-small">{$t('hodlr.buy')}</p>
            <p class="text-on-surface text-body-medium">${buyPrice}</p>
          </div>
          <div>
            <p class="text-on-surface-variant text-body-small">{$t('hodlr.sell')}</p>
            <p class="text-on-surface text-body-medium">${sellPrice}</p>
          </div>
        </div>
      {:else}
        <p class="text-on-surface-variant text-title-large">{$t('hodlr.closed')}</p>
        <p class="text-on-surface-variant text-body-small">
          {$t('hodlr.closedHint')}
        </p>
      {/if}
    </div>

    {#if $priceStore.history.length < 2}
      <EmptyState
        title={$t('hodlr.noHistoryTitle')}
        description={$t('hodlr.noHistoryDescription')}
      />
    {:else}
      <Chart history={$priceStore.history} />
    {/if}

    <div class="bg-surface-container rounded-box p-4">
      <p class="text-on-surface-variant text-body-small">{$t('hodlr.youHold')}</p>
      <p class="text-on-surface text-title-medium">
        {$t('hodlr.holdingAmount', { quantity: $portfolioStore.quantity })}
      </p>
      {#if open}
        <p class="text-on-surface-variant text-body-medium">
          {$t('hodlr.worth', { value: $portfolioStore.currentValue })}
        </p>
      {/if}
    </div>

    <div class="flex gap-2">
      <button
        type="button"
        disabled={!open}
        onclick={onbuy}
        class="bg-primary text-on-primary text-label-large disabled:bg-disabled-container disabled:text-disabled-content disabled:hover:bg-disabled-container disabled:hover:text-disabled-content disabled:cursor-not-allowed flex-1 rounded-full py-3"
      >
        {$t('hodlr.buy')}
      </button>
      <button
        type="button"
        disabled={!open}
        onclick={onsell}
        class="bg-surface-container-high text-on-surface text-label-large disabled:bg-disabled-container disabled:text-disabled-content disabled:hover:bg-disabled-container disabled:hover:text-disabled-content disabled:cursor-not-allowed flex-1 rounded-full py-3"
      >
        {$t('hodlr.sell')}
      </button>
    </div>
  {/if}
</div>
