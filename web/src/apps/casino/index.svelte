<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Screen,
    onAppForeground,
    registerMessages,
    useAppLevels,
    useLocale,
    type AppProps
  } from '@mica/sdk';
  import Roulette from './components/Roulette.svelte';
  import Crash from './components/Crash.svelte';
  import History from './components/History.svelte';
  import { refresh } from './store';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // A `core: false` add-on ships its own catalog in its own bundle (MICA-215).
  registerMessages('casino', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  type Tab = 'roulette' | 'crash' | 'history';
  let tab = $state<Tab>('roulette');

  const app = useAppLevels({
    appId: 'casino',
    title: () => $t('casino.title'),
    onback: () => onback(),
    levels: []
  });

  // Every visit: the limits, a crash round still running on the server, and history. Apps are
  // resident, so mount runs once a session and would show the first visit forever (§11).
  onAppForeground('casino', () => {
    void refresh();
  });
</script>

<Screen title={app.title} onback={app.back}>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="px-4 pt-2">
      <div
        role="group"
        aria-label={$t('casino.tabs')}
        class="border-outline-variant bg-surface-container-low flex rounded-box border p-1"
      >
        <button
          type="button"
          data-testid="casino-tab-roulette"
          aria-pressed={tab === 'roulette'}
          onclick={() => (tab = 'roulette')}
          class="text-label-large flex-1 cursor-pointer rounded-chip py-1.5 text-center {tab ===
          'roulette'
            ? 'bg-surface-container-high-selected text-on-surface'
            : 'text-on-surface-variant'}"
        >
          {$t('casino.tabRoulette')}
        </button>
        <button
          type="button"
          data-testid="casino-tab-crash"
          aria-pressed={tab === 'crash'}
          onclick={() => (tab = 'crash')}
          class="text-label-large flex-1 cursor-pointer rounded-chip py-1.5 text-center {tab ===
          'crash'
            ? 'bg-surface-container-high-selected text-on-surface'
            : 'text-on-surface-variant'}"
        >
          {$t('casino.tabCrash')}
        </button>
        <button
          type="button"
          data-testid="casino-tab-history"
          aria-pressed={tab === 'history'}
          onclick={() => (tab = 'history')}
          class="text-label-large flex-1 cursor-pointer rounded-chip py-1.5 text-center {tab ===
          'history'
            ? 'bg-surface-container-high-selected text-on-surface'
            : 'text-on-surface-variant'}"
        >
          {$t('casino.tabHistory')}
        </button>
      </div>
    </div>

    <!-- Each game keeps its state in the store, so switching tabs loses nothing; a crash round
         keeps running (and can still end by push) while Roulette is on screen. -->
    {#if tab === 'roulette'}
      <Roulette />
    {:else if tab === 'crash'}
      <Crash />
    {:else}
      <History />
    {/if}
  </div>
</Screen>
