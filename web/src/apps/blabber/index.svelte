<script lang="ts">
  import {
    EmptyState,
    Screen,
    SegmentedControl,
    Skeleton,
    onAppForeground,
    useAppAction,
    useAppEvents,
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
  import Thread from './components/Thread.svelte';
  import Messages from './components/Messages.svelte';

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
    deleteBlab,
    engagement,
    loadEngagement,
    toggleLike,
    mouthBlab,
    clearUnreadMentions,
    unreadDms
  } = useBlabber();
  const { run, busy } = useAppAction();

  let view = $state<'feed' | 'profile' | 'thread' | 'dms'>('feed');
  /** Which correspondent's thread is open, or null for the inbox. */
  let dmPeer = $state<number | null>(null);
  let profileHandle = $state<string | null>(null);
  let editing = $state<Blab | null>(null);
  /**
   * The thread stack, not a single value.
   *
   * Opening a reply's own thread pushes onto it, so Back walks out one level at a time instead
   * of jumping to the feed. Replies nest through one column, so the depth is whatever the
   * conversation is.
   */
  let threads = $state<Blab[]>([]);

  /**
   * Every visit, not once per session — apps stay resident, so `onMount` would fetch whatever
   * was true the first time the app was ever opened (§11).
   */
  onAppForeground('blabber', () => {
    void loadMyAccounts();
    // Top-level only. A timeline that mixed replies in would show half a conversation with no
    // way to see what it was replying to — and `reply_to: null` is expressible only because a
    // null filter now means IS NULL rather than `= NULL`.
    void feed.load({ reply_to: null });
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

  /**
   * A mention arriving while the app is on screen.
   *
   * Component-scoped on purpose: this is the *live* half. The badge is fed by a module-scope
   * subscription in the store, which is what keeps it correct while the app is closed — here the
   * player is already looking, so the useful response is to pull the new Blab in and drop the
   * badge rather than raise a count they can see the cause of.
   *
   * `replayed` distinguishes a catch-up from something that just happened: on mount the buffer
   * flushes whatever arrived while the app was unmounted, and that should not scroll the feed.
   */
  const openDms = (peer: number | null = null) => {
    dmPeer = peer;
    view = 'dms';
  };

  useAppEvents('blabber').on('mention', (event) => {
    clearUnreadMentions();
    if (!event.replayed) void feed.load({ reply_to: null });
  });

  const app = useAppLevels({
    appId: 'blabber',
    title: 'Blabber',
    onback: () => onback(),
    levels: [
      // Deepest first. Back pops one thread, then leaves the thread view, then the profile,
      // and only then leaves the app.
      {
        open: () => view === 'thread' && threads.length > 1,
        close: () => threads.pop(),
        title: () => 'Thread'
      },
      {
        open: () => view === 'thread',
        close: () => {
          threads = [];
          view = 'feed';
        },
        title: () => 'Thread'
      },
      { open: () => view === 'profile', close: () => (view = 'feed'), title: () => 'Profile' },
      {
        open: () => view === 'dms' && dmPeer !== null,
        close: () => (dmPeer = null),
        title: () => 'Message'
      },
      { open: () => view === 'dms', close: () => (view = 'feed'), title: () => 'Messages' }
    ]
  });

  const openProfile = (handle: string) => {
    profileHandle = handle;
    view = 'profile';
  };

  const openThread = (blab: Blab) => {
    threads = view === 'thread' ? [...threads, blab] : [blab];
    view = 'thread';
  };

  const like = (blab: Blab) => void run(() => toggleLike(blab.id), { title: 'Blabber' });

  const mouth = (blab: Blab) =>
    void run(() => mouthBlab(blab.id), { title: 'Blabber', success: 'Mouthed' });

  const replyTo = async (parent: Blab, body: string): Promise<void> => {
    // Awaited and discarded: Thread refreshes itself afterwards, and `run` resolves to a
    // success flag the reply composer has no use for.
    await run(() => postBlab(body, parent.id), { title: 'Blabber', success: 'Replied' });
  };

  /**
   * Counts for whatever is on screen, refreshed when the window grows.
   *
   * One batched read per page rather than three per row — thirty posts asking individually is
   * ninety round trips through NUI.
   */
  $effect(() => {
    const ids = page.visible.map((blab) => blab.id);
    if (ids.length > 0) void loadEngagement(ids);
  });

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
  {#if view === 'dms'}
    <Messages
      handle={$activeAccount?.handle}
      busy={$busy}
      peer={dmPeer}
      onopen={(peer) => (dmPeer = peer)}
      onhandle={openProfile}
    />
  {:else if view === 'thread' && threads.length > 0}
    <Thread
      root={threads[threads.length - 1]}
      handle={$activeAccount?.handle}
      busy={$busy}
      onhandle={openProfile}
      onopen={openThread}
      onreply={replyTo}
      onmouth={mouth}
      onlike={like}
    />
  {:else if view === 'profile' && profileHandle}
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
    <div class="flex items-center justify-between border-b border-gray-800 px-3 py-2">
      <p class="text-xs text-gray-500">
        Posting as <span class="text-sky-400">@{$activeAccount?.handle ?? ''}</span>
      </p>
      <button
        type="button"
        class="relative flex items-center gap-1.5 text-xs text-sky-400 hover:underline"
        onclick={() => openDms(null)}
      >
        Messages
        {#if $unreadDms > 0}
          <span class="rounded-full bg-sky-500 px-1.5 text-[10px] font-bold text-white">
            {$unreadDms}
          </span>
        {/if}
      </button>
    </div>

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
        initial={editing.body ?? ''}
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
            stats={$engagement[blab.id]}
            onhandle={openProfile}
            onedit={(b) => (editing = b)}
            ondelete={remove}
            onreply={openThread}
            onmouth={mouth}
            onlike={like}
            onopen={openThread}
          />
        {/each}
        {#if page.loading}
          <div class="p-4"><Skeleton count={2} height="h-16" /></div>
        {/if}
      {/if}
    </div>
  {/if}
</Screen>
