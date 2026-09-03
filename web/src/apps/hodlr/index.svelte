<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Screen, registerMessages, useAppLevels, useLocale, type AppProps } from '@gos/sdk';
  import Portfolio from './components/Portfolio.svelte';
  import Trade from './components/Trade.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-215: Hodlr is a `core: false` add-on and ships its own bundle, so its catalog
  // travels with it — registered here, read as `hodlr.*` everywhere below.
  registerMessages('hodlr', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  type HodlrScreen = { name: 'portfolio' } | { name: 'trade'; side: 'buy' | 'sell' };

  let screen = $state<HodlrScreen>({ name: 'portfolio' });

  const app = useAppLevels({
    appId: 'hodlr',
    title: () => $t('hodlr.title'),
    onback: () => onback(),
    levels: [
      {
        open: () => screen.name !== 'portfolio',
        close: () => (screen = { name: 'portfolio' })
      }
    ]
  });
</script>

<Screen title={app.title} onback={app.back}>
  {#if screen.name === 'portfolio'}
    <Portfolio
      onbuy={() => (screen = { name: 'trade', side: 'buy' })}
      onsell={() => (screen = { name: 'trade', side: 'sell' })}
    />
  {:else}
    <Trade side={screen.side} onback={() => (screen = { name: 'portfolio' })} />
  {/if}
</Screen>
