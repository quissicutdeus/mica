<script lang="ts">
  import { onMount } from 'svelte';
  import { EmptyState, Skeleton, onAppForeground } from '@gphone/sdk';
  import { useHodlr } from '../store';
  import Chart from './Chart.svelte';

  let { onbuy, onsell }: { onbuy: () => void; onsell: () => void } = $props();

  const { priceStore, portfolioStore, loadPrice, loadPortfolio } = useHodlr();

  let loaded = $state(false);

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
    <div class="bg-surface-container rounded-xl p-4">
      <p class="text-on-surface-variant text-body-small">gCoin price</p>
      <p class="text-on-surface text-title-large">${$priceStore.current}</p>
    </div>

    {#if $priceStore.history.length < 2}
      <EmptyState title="No history yet" description="Check back after the market ticks." />
    {:else}
      <Chart history={$priceStore.history} />
    {/if}

    <div class="bg-surface-container rounded-xl p-4">
      <p class="text-on-surface-variant text-body-small">You hold</p>
      <p class="text-on-surface text-title-medium">{$portfolioStore.quantity} gCoin</p>
      <p class="text-on-surface-variant text-body-medium">worth ${$portfolioStore.currentValue}</p>
    </div>

    <div class="flex gap-2">
      <button
        type="button"
        onclick={onbuy}
        class="bg-primary text-on-primary text-label-large flex-1 rounded-full py-3"
      >
        Buy
      </button>
      <button
        type="button"
        onclick={onsell}
        class="bg-surface-container-high text-on-surface text-label-large flex-1 rounded-full py-3"
      >
        Sell
      </button>
    </div>
  {/if}
</div>
