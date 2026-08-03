<script lang="ts">
  import {
    EmptyState,
    Screen,
    SegmentedControl,
    Skeleton,
    onAppForeground,
    useAppAction,
    useAppLevels,
    useBlabber,
    usePagedList,
    type AppProps
  } from '@gphone/sdk';
  import type { Blab } from '@shared/types';
  import BlabRow from './components/BlabRow.svelte';
  import Composer from './components/Composer.svelte';
  import ClaimHandle from './components/ClaimHandle.svelte';
  import Profile from './components/Profile.svelte';

  let { onback }: AppProps = $props();

  const {
    feed,
    myAccounts,
    accountsLoaded,
    activeAccount,
    activeAccountId,
    loadMyAccounts,
    claimAccount,
    postBlab,
    editBlab,
    deleteBlab
  } = useBlabber();
  const { run, busy } = useAppAction();

  let view = $state<'feed' | 'profile'>('feed');
  let profileHandle = $state<string | null>(null);
  let editing = $state<Blab | null>(null);

  /**
   * Every visit, not once per session — apps stay resident, so `onMount` would fetch whatever
   * was true the first time the app was ever opened (§11).
   */
  onAppForeground('blabber', () => {
    void loadMyAccounts();
    void feed.load();
  });

  /**
   * A window over a *server*-paged list. `loadOlder` is what makes it that rather than a window
   * over an array already in memory — a public feed is never fully loaded.
   */
  const page = usePagedList<Blab>({
    items: () => $feed,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: () => feed.loadMore(),
    hasMore: () => hasMoreSnapshot
  });

  let hasMoreSnapshot = $state(false);
  feed.hasMore.subscribe((value) => (hasMoreSnapshot = value));

  const app = useAppLevels({
    appId: 'blabber',
    title: 'Blabber',
    onback: () => onback(),
    levels: [
      // Deepest first. A profile is a level up from the feed, so Back returns to it rather
      // than leaving the app.
      { open: () => view === 'profile', close: () => (view = 'feed'), title: () => 'Profile' }
    ]
  });

  const openProfile = (handle: string) => {
    profileHandle = handle;
    view = 'profile';
  };

  const post = (body: string) =>
    void run(() => postBlab(body), { title: 'Blabber', success: 'Posted' });

  const saveEdit = (body: string) => {
    const target = editing;
    if (!target) return;
    editing = null;
    void run(() => editBlab(target.id, body), { title: 'Blabber', success: 'Updated' });
  };

  const remove = (blab: Blab) =>
    void run(() => deleteBlab(blab.id), { title: 'Blabber', success: 'Deleted' });

  /** Mine to edit if it was posted by one of my accounts. The server decides for real. */
  const isMine = (blab: Blab) => $myAccounts.some((account) => account.id === blab.account_id);
</script>

<Screen title={app.title} onback={app.back}>
  {#if view === 'profile' && profileHandle}
    <Profile handle={profileHandle} onhandle={openProfile} />
  {:else if !$accountsLoaded}
    <div class="p-4"><Skeleton count={4} height="h-16" /></div>
  {:else if $myAccounts.length === 0}
    <!-- Nothing to post from yet. Told, rather than shown an empty feed and a dead composer. -->
    <ClaimHandle
      busy={$busy}
      onclaim={(handle) =>
        run(() => claimAccount(handle), {
          title: 'Blabber',
          success: 'Handle claimed'
        })}
    />
  {:else}
    {#if $myAccounts.length > 1}
      <div class="border-b border-gray-800 p-2">
        <SegmentedControl
          aria-label="Post as"
          selected={String($activeAccount?.id ?? '')}
          onchange={(id) => activeAccountId.set(Number(id))}
          options={$myAccounts.map((a) => ({ id: String(a.id), label: `@${a.handle}` }))}
        />
      </div>
    {/if}

    {#if editing}
      <Composer
        handle={$activeAccount?.handle}
        initial={editing.body}
        placeholder="Fix a typo"
        busy={$busy}
        onsubmit={saveEdit}
        oncancel={() => (editing = null)}
      />
    {:else}
      <Composer handle={$activeAccount?.handle} busy={$busy} onsubmit={post} />
    {/if}

    <div class="flex-1 overflow-y-auto" onscroll={page.onScroll}>
      {#if $feed.length === 0}
        <EmptyState title="Nothing here yet" description="Be the first to say something." />
      {:else}
        {#each page.visible as blab (blab.id)}
          <BlabRow
            {blab}
            editable={isMine(blab)}
            onhandle={openProfile}
            onedit={(b) => (editing = b)}
            ondelete={remove}
          />
        {/each}
        {#if page.loading}
          <div class="p-4"><Skeleton count={2} height="h-16" /></div>
        {/if}
      {/if}
    </div>
  {/if}
</Screen>
