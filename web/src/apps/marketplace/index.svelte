<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Screen, registerMessages, useAppLevels, useLocale, type AppProps } from '@gos/sdk';
  import Feed from './components/Feed.svelte';
  import ListingDetail from './components/ListingDetail.svelte';
  import CreateListing from './components/CreateListing.svelte';
  import MyListings from './components/MyListings.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-215: Snatchr's own catalog, registered once for every screen under it.
  registerMessages('marketplace', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  type MarketplaceScreen =
    { name: 'feed' } | { name: 'detail'; id: number } | { name: 'create' } | { name: 'mine' };

  let screen = $state<MarketplaceScreen>({ name: 'feed' });

  const app = useAppLevels({
    appId: 'marketplace',
    title: () => $t('marketplace.title'),
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
      onselect={(id: number) => (screen = { name: 'detail', id })}
      onCreate={() => (screen = { name: 'create' })}
      onMyListings={() => (screen = { name: 'mine' })}
    />
  {:else if screen.name === 'detail'}
    <ListingDetail id={screen.id} onback={() => (screen = { name: 'feed' })} />
  {:else if screen.name === 'create'}
    <CreateListing
      onposted={(id: number) => (screen = { name: 'detail', id })}
      oncancel={() => (screen = { name: 'feed' })}
    />
  {:else if screen.name === 'mine'}
    <MyListings onback={() => (screen = { name: 'feed' })} />
  {/if}
</Screen>
