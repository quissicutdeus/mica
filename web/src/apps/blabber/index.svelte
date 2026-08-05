<script lang="ts">
  import {
    AddIcon,
    Avatar,
    EmptyState,
    FloatingActionButton,
    MessageIcon,
    Screen,
    Skeleton,
    onAppForeground,
    useAppAction,
    useAppEvents,
    useAppLevels,
    useBlabber,
    usePagedList,
    type AppProps
  } from '@gphone/sdk';
  import type { Account, Blab } from '@shared/types';
  import AccountMenu from './components/AccountMenu.svelte';
  import BlabRow from './components/BlabRow.svelte';
  import Composer from './components/Composer.svelte';
  import ClaimHandle from './components/ClaimHandle.svelte';
  import EditProfile from './components/EditProfile.svelte';
  import Profile from './components/Profile.svelte';
  import Thread from './components/Thread.svelte';
  import Messages from './components/Messages.svelte';

  let { onback }: AppProps = $props();

  /**
   * Just enough about a correspondent to title a DM thread. Matches the shape `Messages.svelte`
   * accepts: the inbox row carries a handle and a display name and no more, so requiring a whole
   * `Account` would force that call site to invent an id and two timestamps.
   */
  type DmPeer = Pick<Account, 'handle' | 'display_name'> & { avatar?: string | null };

  const {
    feed,
    myAccounts,
    accountsLoaded,
    accountLimit,
    canClaimAnother,
    activeAccount,
    activeAccountId,
    loadMyAccounts,
    claimAccount,
    updateAccount,
    postBlab,
    editBlab,
    deleteBlab,
    engagement,
    loadEngagement,
    toggleLike,
    mouthBlab,
    clearUnreadMentions,
    loadDmThreads,
    unreadDms
  } = useBlabber();
  const { run, busy } = useAppAction();

  /**
   * False until the first page has come back. An empty feed and a feed that has not answered yet
   * are different statements, and the app made the second one look like the first (§11.6).
   */
  const feedLoaded = feed.loaded;

  let view = $state<'feed' | 'profile' | 'thread' | 'dms'>('feed');
  /** Which correspondent's thread is open, or null for the inbox. */
  let dmPeer = $state<number | null>(null);
  /**
   * Who that correspondent is, when the inbox does not know yet.
   *
   * The DM header and the level title used to read the peer out of `$dmThreads`, so a
   * conversation started from a profile — before either side has sent anything — had no row to
   * find and rendered `@` with a `?` avatar under the literal title "Message". Carrying the
   * account we already had in hand is what makes starting a DM from a profile possible at all.
   */
  let dmPeerAccount = $state<DmPeer | null>(null);
  /** The inbox's own answer, for a thread opened from it rather than from a profile. */
  let dmThreadName = $state<string | null>(null);
  let profileHandle = $state<string | null>(null);
  let editing = $state<Blab | null>(null);
  /** Composing a new Blab. Separate from `editing`, which reuses the same overlay. */
  let composing = $state(false);
  /** Identity: the header menu, and the two screens it opens. */
  let menu = $state(false);
  let editingProfile = $state(false);
  let claiming = $state(false);
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
    /**
     * The DM badge is derived from `dmThreads`, and nothing filled that until the inbox was
     * opened — so the count next to Messages read 0 on every visit unless a DM happened to
     * arrive while the app was on screen. The push subscription keeps it live; this is what
     * makes it right on arrival.
     */
    void loadDmThreads();
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

  const openDms = (peer: number | null = null, account: DmPeer | null = null) => {
    dmPeer = peer;
    dmPeerAccount = account;
    view = 'dms';
  };

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
  useAppEvents('blabber').on('mention', (event) => {
    clearUnreadMentions();
    if (!event.replayed) void feed.load({ reply_to: null });
  });

  const closeComposer = () => {
    composing = false;
    editing = null;
  };

  /**
   * Who the open DM thread is with.
   *
   * A plain function rather than a `$derived`, because `useAppLevels` reads it through a callback
   * and a rune declared after that call would be read before it is initialised.
   */
  const dmTitle = (): string => {
    if (dmPeerAccount) return dmPeerAccount.display_name || `@${dmPeerAccount.handle}`;
    return dmThreadName ?? 'Message';
  };

  const app = useAppLevels({
    appId: 'blabber',
    title: 'Blabber',
    onback: () => onback(),
    levels: [
      /**
       * Deepest first, and every overlay is its own rung — an overlay that is not one is an
       * overlay Backspace skips straight past, sending the player home from what looks like a
       * modal (§2.7).
       */
      {
        open: () => composing || editing !== null,
        close: closeComposer,
        title: () => (editing ? 'Edit' : 'New Blab')
      },
      {
        open: () => editingProfile,
        close: () => (editingProfile = false),
        title: () => 'Edit profile'
      },
      { open: () => claiming, close: () => (claiming = false), title: () => 'New handle' },
      { open: () => menu, close: () => (menu = false), title: () => 'Posting as' },
      // Back pops one thread, then leaves the thread view, then the profile, and only then
      // leaves the app.
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
        close: () => {
          dmPeer = null;
          dmPeerAccount = null;
        },
        // The peer, not the literal `Message` this used to be.
        title: dmTitle
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

  const post = (body: string) => {
    composing = false;
    void run(() => postBlab(body), { title: 'Blabber', success: 'Posted' });
  };

  const saveEdit = (body: string) => {
    const target = editing;
    if (!target) return;
    editing = null;
    void run(() => editBlab(target.id, body), { title: 'Blabber', success: 'Updated' });
  };

  const remove = (blab: Blab) =>
    void run(() => deleteBlab(blab.id), { title: 'Blabber', success: 'Deleted' });

  const claim = async (handle: string): Promise<void> => {
    if (await run(() => claimAccount(handle), { title: 'Blabber', success: 'Handle claimed' })) {
      claiming = false;
    }
  };

  const saveProfile = async (patch: {
    display_name: string | null;
    bio: string | null;
  }): Promise<void> => {
    const account = $activeAccount;
    if (!account) return;
    if (
      await run(() => updateAccount(account.id, patch), {
        title: 'Blabber',
        success: 'Profile updated'
      })
    ) {
      editingProfile = false;
    }
  };

  /** Mine to edit if it was posted by one of my accounts. The server decides for real. */
  const isMine = (blab: Blab) => $myAccounts.some((account) => account.id === blab.account_id);

  /** The feed is the only place the composer FAB belongs — every other view has its own action. */
  const showFab = $derived(
    view === 'feed' &&
      $accountsLoaded &&
      $myAccounts.length > 0 &&
      !composing &&
      editing === null &&
      !menu &&
      !editingProfile &&
      !claiming
  );
</script>

{#snippet headerActions()}
  <!-- The feed only. Inside Messages a Messages button is noise, and inside a thread or a
       profile the header already belongs to what you are reading. -->
  {#if view === 'feed' && $accountsLoaded && $myAccounts.length > 0}
    <div class="ml-auto flex items-center gap-1">
      <button
        type="button"
        class="relative rounded-full p-2 text-gray-300 transition-colors hover:bg-gray-700"
        onclick={() => openDms(null)}
        title="Messages"
        aria-label="Messages"
      >
        <MessageIcon class="h-5 w-5" />
        {#if $unreadDms > 0}
          <span
            class="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-sky-500 px-1 text-[10px] leading-4 font-bold text-white"
          >
            {$unreadDms > 99 ? '99+' : $unreadDms}
          </span>
        {/if}
      </button>
      <!-- Identity, demoted from a strip and a switcher above the feed to the one control that
           opens all of it. -->
      <button
        type="button"
        class="rounded-full transition-transform hover:scale-105"
        onclick={() => (menu = true)}
        title="Posting as @{$activeAccount?.handle ?? ''}"
        aria-label="Posting as @{$activeAccount?.handle ?? ''}"
      >
        <Avatar
          initials={($activeAccount?.handle ?? '?').slice(0, 2).toUpperCase()}
          src={$activeAccount?.avatar ?? ''}
          size="w-7 h-7"
          textClass="text-[10px]"
          showSilhouette={false}
        />
      </button>
    </div>
  {/if}
{/snippet}

{#snippet overlays()}
  {#if composing || editing}
    <!-- Full screen rather than pinned above the feed: the dominant modal shape in the repo,
         and the composer is now reached from the FAB rather than always mounted. -->
    <div class="animate-in fade-in bg-surface absolute inset-0 z-30 flex flex-col duration-200">
      <Composer
        handle={$activeAccount?.handle}
        initial={editing?.body ?? ''}
        placeholder={editing ? 'Fix a typo' : "What's happening?"}
        busy={$busy}
        onsubmit={editing ? saveEdit : post}
        oncancel={closeComposer}
      />
    </div>
  {/if}

  {#if editingProfile && $activeAccount}
    <EditProfile
      account={$activeAccount}
      busy={$busy}
      onsave={saveProfile}
      oncancel={() => (editingProfile = false)}
    />
  {/if}

  {#if claiming}
    <div class="animate-in fade-in bg-surface absolute inset-0 z-30 flex flex-col duration-200">
      <ClaimHandle busy={$busy} onclaim={claim} oncancel={() => (claiming = false)} />
    </div>
  {/if}

  {#if menu}
    <AccountMenu
      accounts={$myAccounts}
      activeId={$activeAccount?.id ?? null}
      canClaim={$canClaimAnother}
      limit={$accountLimit}
      onswitch={(id) => {
        activeAccountId.set(id);
        menu = false;
      }}
      onclaim={() => {
        menu = false;
        claiming = true;
      }}
      onedit={() => {
        menu = false;
        editingProfile = true;
      }}
      onclose={() => (menu = false)}
    />
  {/if}

  {#if showFab}
    <FloatingActionButton label="Blab" collapsed onclick={() => (composing = true)}>
      {#snippet icon()}
        <AddIcon class="h-4 w-4 shrink-0 text-white" />
      {/snippet}
    </FloatingActionButton>
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions} overlay={overlays}>
  {#if view === 'dms'}
    <Messages
      busy={$busy}
      peer={dmPeer}
      peerAccount={dmPeerAccount}
      onopen={(peer, account) => {
        dmPeer = peer;
        dmPeerAccount = account ?? null;
      }}
      onpeername={(name) => (dmThreadName = name)}
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
    <Profile
      handle={profileHandle}
      onhandle={openProfile}
      onmessage={(account) => openDms(account.id, account)}
    />
  {:else if !$accountsLoaded}
    <div class="p-4"><Skeleton count={4} height="h-16" /></div>
  {:else if $myAccounts.length === 0}
    <!-- Nothing to post from yet. Told, rather than shown an empty feed and a dead composer. -->
    <ClaimHandle busy={$busy} onclaim={claim} />
  {:else}
    <div class="flex-1 overflow-y-auto" onscroll={page.onScroll}>
      {#if !$feedLoaded}
        <!-- Still waiting on the first page. "Nothing here yet" is a claim about the feed, and
             making it before the server has answered is a claim the app cannot support. -->
        <div class="p-4"><Skeleton count={4} height="h-16" /></div>
      {:else if $feed.length === 0}
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
