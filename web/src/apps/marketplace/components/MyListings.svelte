<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    EmptyState,
    Skeleton,
    formatCurrency,
    onAppForeground,
    useLocale,
    useMarketplace
  } from '@mica/sdk';

  const { mineStore, loadMine, markSold, removeListing } = useMarketplace();
  const { t } = useLocale();

  let loaded = $state(false);

  // Every visit, not once per session — apps stay resident (AGENTS.md §11, MICA-413).
  onAppForeground('marketplace', () => {
    void loadMine().then(() => (loaded = true));
  });
</script>

<!-- No back arrow here: `Screen`'s header back leaves this level (MICA-418). -->
<p class="text-on-surface text-title-medium p-4">{$t('marketplace.myListings')}</p>

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
          <p class="text-on-surface-variant text-body-small">
            ${formatCurrency(row.price)} · {row.status}
          </p>
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
