<script lang="ts">
  import { Screen, useAppLevels, type AppProps } from '@gphone/sdk';
  import Feed from './components/Feed.svelte';
  import ListingDetail from './components/ListingDetail.svelte';
  import CreateListing from './components/CreateListing.svelte';
  import MyListings from './components/MyListings.svelte';

  let { onback }: AppProps = $props();

  type MarketplaceScreen =
    | { name: 'feed' }
    | { name: 'detail'; id: number }
    | { name: 'create' }
    | { name: 'mine' };

  let screen = $state<MarketplaceScreen>({ name: 'feed' });

  const app = useAppLevels({
    appId: 'marketplace',
    title: 'Marketplace',
    onback: () => onback(),
    levels: [
      {
        open: () => screen.name !== 'feed',
        close: () => (screen = { name: 'feed' })
      }
    ]
  });
</script>

<Screen title={app.title} onback={app.back}>
  {#if screen.name === 'feed'}
    <Feed
      onselect={(id) => (screen = { name: 'detail', id })}
      onCreate={() => (screen = { name: 'create' })}
      onMyListings={() => (screen = { name: 'mine' })}
    />
  {:else if screen.name === 'detail'}
    <ListingDetail id={screen.id} onback={() => (screen = { name: 'feed' })} />
  {:else if screen.name === 'create'}
    <CreateListing
      onposted={(id) => (screen = { name: 'detail', id })}
      oncancel={() => (screen = { name: 'feed' })}
    />
  {:else if screen.name === 'mine'}
    <MyListings onback={() => (screen = { name: 'feed' })} />
  {/if}
</Screen>
