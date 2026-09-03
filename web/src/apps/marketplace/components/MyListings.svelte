<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { EmptyState, Skeleton, useLocale, useMarketplace } from '@gos/sdk';

  let { onback }: { onback: () => void } = $props();

  const { mineStore, loadMine, markSold, removeListing } = useMarketplace();
  const { t } = useLocale();

  let loaded = $state(false);

  onMount(() => {
    void loadMine().then(() => (loaded = true));
  });
</script>

<div class="flex items-center gap-2 p-4">
  <button
    type="button"
    onclick={onback}
    aria-label={$t('marketplace.back')}
    class="text-on-surface-variant"
  >
    ←
  </button>
  <p class="text-on-surface text-title-medium">{$t('marketplace.myListings')}</p>
</div>

{#if !loaded}
  <div class="p-4"><Skeleton count={3} height="h-16" /></div>
{:else if $mineStore.rows.length === 0}
  <EmptyState
    title={$t('marketplace.mineEmptyTitle')}
    description={$t('marketplace.mineEmptyDescription')}
  />
{:else}
  <ul class="flex flex-col gap-2 px-4 pb-4">
    {#each $mineStore.rows as row (row.id)}
      <li class="bg-surface-container flex items-center justify-between rounded-box p-3">
        <div class="min-w-0">
          <p class="text-on-surface truncate text-body-large">{row.title}</p>
          <p class="text-on-surface-variant text-body-small">{row.price} · {row.status}</p>
        </div>
        {#if row.status === 'active'}
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              aria-label={$t('marketplace.markSold')}
              onclick={() => markSold(row.id)}
              class="text-primary text-label-large"
            >
              {$t('marketplace.markSold')}
            </button>
            <button
              type="button"
              aria-label={$t('marketplace.remove')}
              onclick={() => removeListing(row.id)}
              class="text-error text-label-large"
            >
              {$t('marketplace.remove')}
            </button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
