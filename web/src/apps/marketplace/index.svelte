<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Screen,
    registerMessages,
    useAppLevels,
    useDeepLink,
    useLocale,
    type AppProps
  } from '@mica/sdk';
  import Feed from './components/Feed.svelte';
  import ListingDetail from './components/ListingDetail.svelte';
  import CreateListing from './components/CreateListing.svelte';
  import MyListings from './components/MyListings.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-215: Snatchr's own catalog, registered once for every screen under it.
  registerMessages('marketplace', { en, de });
  const { t } = useLocale();

  let { onback, listingId }: AppProps & { listingId?: number } = $props();

  type MarketplaceScreen =
    { name: 'feed' } | { name: 'detail'; id: number } | { name: 'create' } | { name: 'mine' };

  let screen = $state<MarketplaceScreen>({ name: 'feed' });

  /**
   * Open the listing a search result named (MICA-286).
   *
   * No wait for the feed: `ListingDetail` reads its own row by id, so a link into a
   * listing that is not in the cached page still lands on the listing rather than on the
   * feed. That is why this returns `true` immediately, unlike the deep links whose target
   * has to exist in a store first.
   */
  useDeepLink('marketplace', () => {
    if (!listingId) return false;
    screen = { name: 'detail', id: listingId };
    return true;
  });

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
