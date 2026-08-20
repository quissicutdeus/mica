<script lang="ts">
  import { Screen, useAppLevels, type AppProps } from '@gphone/sdk';
  import Portfolio from './components/Portfolio.svelte';
  import Trade from './components/Trade.svelte';

  let { onback }: AppProps = $props();

  type HodlrScreen = { name: 'portfolio' } | { name: 'trade'; side: 'buy' | 'sell' };

  let screen = $state<HodlrScreen>({ name: 'portfolio' });

  const app = useAppLevels({
    appId: 'hodlr',
    title: 'Hodlr',
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
