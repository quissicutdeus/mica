<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Screen,
    SegmentedControl,
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

  // `roulette`, `crash` or `history`: the ids of the options below, bound as a plain string
  // because that is what `SegmentedControl` binds.
  let tab = $state('roulette');

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
      <SegmentedControl
        aria-label={$t('casino.tabs')}
        options={[
          { id: 'roulette', label: $t('casino.tabRoulette') },
          { id: 'crash', label: $t('casino.tabCrash') },
          { id: 'history', label: $t('casino.tabHistory') }
        ]}
        bind:selected={tab}
      />
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
