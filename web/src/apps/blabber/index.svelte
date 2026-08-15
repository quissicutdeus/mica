<script lang="ts">
  import {
    AddIcon,
    Avatar,
    BellIcon,
    EmptyState,
    FloatingActionButton,
    HomeIcon,
    MessageIcon,
    Screen,
    SearchIcon,
    Skeleton,
    TabBar,
    UsersIcon,
    onAppForeground,
    useAppAction,
    useAppEvents,
    useAppLevels,
    useNotifications,
    usePagedList,
    useDeepLink,
    type AppProps
  } from '@gphone/sdk';
  import { useBlabber } from './store';
  import type { Account, Blab } from '@shared/types';
  import AccountMenu from './components/AccountMenu.svelte';
  import BlabRow from './components/BlabRow.svelte';
  import Composer from './components/Composer.svelte';
  import ClaimHandle from './components/ClaimHandle.svelte';
  import EditProfile from './components/EditProfile.svelte';
  import FollowList from './components/FollowList.svelte';
  import Profile from './components/Profile.svelte';
  import BlabDetail from './components/BlabDetail.svelte';
  import Messages from './components/Messages.svelte';
  import NotificationsTab from './components/NotificationsTab.svelte';
  import TaggedFeed from './components/TaggedFeed.svelte';
  import Search from './components/Search.svelte';

  let {
    onback,
    blabId,
    handle,
    dmHandle
  }: AppProps & {
    blabId?: number;
    handle?: string;
    dmHandle?: string;
  } = $props();

  /**
   * Just enough about a correspondent to title a DM thread. Matches the shape `Messages.svelte`
   * accepts: the inbox row carries a handle and a display name and no more, so requiring a whole
   * `Account` would force that call site to invent an id and two timestamps.
   */
  type DmPeer = Pick<Account, 'handle' | 'display_name'> & { avatar?: string | null };

  const {
    feed,
    loadFeed,
    followingFeed,
    loadFollowing,
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
    toggleEar,
    mouthBlab,
    loadDmThreads,
    dmThreads,
    unreadDms
  } = useBlabber();
  const { run, busy } = useAppAction('blabber');
  /**
   * The Notifications tab reads the OS shade filtered to this app, so the fetch is the shell's
   * rather than Blabber's — the app id only narrows the view.
   */
  const { load: loadNotifications } = useNotifications('blabber');

  /**
   * False until the first page has come back. An empty feed and a feed that has not answered yet
   * are different statements, and the app made the second one look like the first (§11.6).
   */
  const feedLoaded = feed.loaded;

  let view = $state<'feed' | 'profile' | 'thread' | 'dms' | 'follows' | 'tag'>('feed');
  /**
   * Which top-level destination the bottom nav is on.
   *
   * Separate from `view`, which is the overlay stack above it — a thread opened from Following
   * comes back to Following.
   */
  let tab = $state<'feed' | 'following' | 'notifications' | 'search'>('feed');
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
  /** Which tag a `TaggedFeed` screen is showing — an inline `#tag` tap, the Tags search segment,
   * or a trending chip all land here. */
  let activeTag = $state<string | null>(null);
  /**
   * Whose follow list is open, and which direction.
   *
   * The account rather than the handle, because the list is read by account id — a handle would
   * mean resolving it a second time when the profile that opened it already had the row in hand.
   */
  let follows = $state<{ account: Account; kind: 'followers' | 'following' } | null>(null);
  let editing = $state<Blab | null>(null);
  /** Composing a new Blab. Separate from `editing`, which reuses the same overlay. */
  let composing = $state(false);
  /** Identity: the header menu, and the two screens it opens. */
  let menu = $state(false);
  let editingProfile = $state(false);
  let claiming = $state(false);
  /**
   * Which Blab is open, or null. One value rather than a stack: `BlabDetail` flattens the whole
   * reply tree into one screen (Task 11), so there is no second level to push onto — opening a
   * reply from inside an already-open Blab is not a thing that happens any more (§ design spec,
   * "Navigation: one screen, not a stack").
   */
  let activeBlabId = $state<number | null>(null);
  /** Set only for a reply reached via search — scrolls that row into view once it renders. */
  let activeAnchorId = $state<number | undefined>(undefined);

  /**
   * Every visit, not once per session — apps stay resident, so `onMount` would fetch whatever
   * was true the first time the app was ever opened (§11).
   */
  onAppForeground('blabber', () => {
    void loadMyAccounts();
    // Top-level only. A timeline that mixed replies in would show half a conversation with no
    // way to see what it was replying to — and `reply_to: null` is expressible only because a
    // null filter now means IS NULL rather than `= NULL`.
    void loadFeed();
    /**
     * The DM badge is derived from `dmThreads`, and nothing filled that until the inbox was
     * opened — so the count next to Messages read 0 on every visit unless a DM happened to
     * arrive while the app was on screen. The push subscription keeps it live; this is what
     * makes it right on arrival.
     */
    void loadDmThreads();
    // Only the tab actually on screen. The others are fetched when switched to — every feed
    // loaded on every visit is round trips nobody asked for.
    if (tab === 'following') void loadFollowing();
    if (tab === 'notifications') void loadNotifications();
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
   * The Following window, its own `usePagedList` over its own store.
   *
   * Two server reads answering two questions, each with its own cursor. One shared window would
   * mean one cursor walking two result sets, so switching tabs would resume the other feed's
   * position.
   */
  const followingPage = usePagedList<Blab>({
    items: () => $followingFeed,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: () => followingFeed.loadMore(),
    hasMore: () => followingHasMore
  });

  let followingHasMore = $state(false);
  followingFeed.hasMore.subscribe((value) => (followingHasMore = value));

  const followingLoaded = followingFeed.loaded;

  /**
   * Switching tabs is what fetches the one being switched to.
   *
   * The id is checked against the tabs that exist rather than folded into a ternary. The ternary
   * form sent every id that was not `following` to the feed, so the Notifications tab — rendered,
   * routed and with a server behind it — could not be opened at all: tapping it selected the feed
   * and looked like a dead button. `TabBar` hands back a bare `string`, so this is the only place
   * that narrowing can happen.
   */
  const selectTab = (next: string) => {
    if (next !== 'feed' && next !== 'following' && next !== 'notifications' && next !== 'search')
      return;
    tab = next;
    if (tab === 'following') void loadFollowing();
    if (tab === 'notifications') void loadNotifications();
  };

  const openDms = (peer: number | null = null, account: DmPeer | null = null) => {
    dmPeer = peer;
    dmPeerAccount = account;
    view = 'dms';
  };

  /**
   * A mention arriving while the app is on screen.
   *
   * Component-scoped on purpose: this is the *live* half — the player is already looking, so the
   * useful response is to pull the new Blab into the feed in front of them.
   *
   * It no longer clears a badge. The badge counts unread notification rows now, and those are
   * marked read by reading them in the Notifications tab, the way every other app in the phone
   * behaves — arriving at the feed is not the same act as reading the mention.
   *
   * `replayed` distinguishes a catch-up from something that just happened: on mount the buffer
   * flushes whatever arrived while the app was unmounted, and that should not scroll the feed.
   */
  useAppEvents('blabber').on('mention', (event) => {
    if (!event.replayed) void loadFeed();
  });

  const closeComposer = () => {
    composing = false;
    editing = null;
  };

  /**
   * Who the open DM thread is with.
   *
   * A plain function rather than a `$derived`, because `useAppLevels` reads it through a callback
   * and a rune declared after that call would be read before it is initialized.
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
      // Back leaves the thread view, then the profile, and only then leaves the app.
      {
        open: () => view === 'thread',
        close: () => {
          activeBlabId = null;
          activeAnchorId = undefined;
          view = 'feed';
        },
        title: () => 'Blab'
      },
      /**
       * One rung for both lists, with the title telling you which — the shape Settings' panes use.
       * Two rungs would be two predicates only one of which can ever be true, which is a dead
       * branch pretending to be a ladder.
       *
       * Above the profile rung, so Back from a follower list returns to the profile it was opened
       * from rather than to the feed.
       */
      {
        open: () => view === 'follows',
        close: () => (view = 'profile'),
        title: () => (follows?.kind === 'following' ? 'Following' : 'Followers')
      },
      { open: () => view === 'profile', close: () => (view = 'feed'), title: () => 'Profile' },
      { open: () => view === 'tag', close: () => (view = 'feed'), title: () => `#${activeTag}` },
      {
        open: () => view === 'dms' && dmPeer !== null,
        close: () => {
          dmPeer = null;
          dmPeerAccount = null;
        },
        // The peer, not the literal `Message` this used to be.
        title: dmTitle
      },
      { open: () => view === 'dms', close: () => (view = 'feed'), title: () => 'Messages' },
      // A non-default tab is the last rung before leaving: Back returns to the public feed rather
      // than sending the player home from Following. The title names the tab you are actually on —
      // hardcoding one of them titled the Notifications tab "Following".
      {
        open: () => tab !== 'feed',
        close: () => (tab = 'feed'),
        title: () =>
          tab === 'notifications' ? 'Notifications' : tab === 'search' ? 'Search' : 'Following'
      }
    ]
  });

  /**
   * Profile navigation is flat, and stays flat.
   *
   * Tapping a handle from a profile replaces the one on screen rather than pushing, which is what
   * this app has always done — so Back from a profile goes to whatever opened the first one. A row
   * in a follower list therefore lands on the profile rung, which is one level *out* of the list
   * it was tapped in. Stacking it would need a profile stack like `threads`, and the two would
   * have to agree about depth; the flat behavior is the one already shipped and tested.
   */
  const openProfile = (handle: string) => {
    profileHandle = handle;
    view = 'profile';
  };

  const openFollows = (account: Account, kind: 'followers' | 'following') => {
    follows = { account, kind };
    view = 'follows';
  };

  const openTag = (tag: string) => {
    activeTag = tag;
    view = 'tag';
  };

  /**
   * Follow a notification into the app.
   *
   * Blabber had none of this. It parsed `blab/(\d+)` inside its own notifications tab —
   * which only helps a player already in the app, on that tab — so a mention tapped from
   * the shade or a toast opened the feed and nothing else. Three kinds of notification
   * pointed here and none of them landed.
   *
   * `dmHandle` waits for the inbox rather than giving up: `false` re-asks, so a cold open
   * follows the link once `loadDmThreads` returns instead of dropping it on the frame the
   * list happened to be empty.
   */
  useDeepLink('blabber', () => {
    if (blabId) {
      openBlab(blabId);
      return true;
    }
    if (handle) {
      openProfile(handle);
      return true;
    }
    if (dmHandle) {
      const peer = $dmThreads.find((row) => row.handle === dmHandle);
      // `handle` is nullable on a thread row — an account can be deleted out from under
      // one — and `DmPeer` is not, so this narrows rather than casting past it.
      if (!peer || !peer.handle) return false;
      openDms(peer.peer_account_id, { handle: peer.handle, display_name: peer.display_name });
      return true;
    }
    return false;
  });

  const openBlab = (id: number, anchorId?: number) => {
    activeBlabId = id;
    activeAnchorId = anchorId;
    view = 'thread';
  };

  const ear = (blab: Blab) => void run(() => toggleEar(blab.id), { title: 'Blabber' });

  const mouth = (blab: Blab) =>
    void run(() => mouthBlab(blab.id), { title: 'Blabber', success: 'Mouthed' });

  /**
   * Counts for whatever is on screen, refreshed when the window grows.
   *
   * One batched read per page rather than three per row — thirty posts asking individually is
   * ninety round trips through NUI.
   */
  $effect(() => {
    // Whichever tab is on screen. Batching both would ask for counts nobody is looking at.
    const visible = tab === 'following' ? followingPage.visible : page.visible;
    const ids = visible.map((blab) => blab.id);
    if (ids.length > 0) void loadEngagement(ids);
  });

  const post = (body: string, attachments?: { photo_id: number }[]) => {
    composing = false;
    void run(() => postBlab(body, undefined, attachments), { title: 'Blabber', success: 'Posted' });
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

  /**
   * A tab, and only a tab, is where the composer FAB and the nav belong.
   *
   * Every other view is an overlay with its own action, and a nav under a thread would offer to
   * navigate away from something the player is reading rather than out of it.
   */
  const onTabs = $derived(
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
        class="text-on-surface hover:bg-surface-container-high duration-short ease-standard relative rounded-full p-2 transition-colors"
        onclick={() => openDms(null)}
        title="Messages"
        aria-label="Messages"
      >
        <MessageIcon class="size-icon-md" />
        {#if $unreadDms > 0}
          <span
            class="bg-primary-container text-on-primary-container text-label-small absolute top-0.5 right-0.5 min-w-4 rounded-full px-1"
          >
            {$unreadDms > 99 ? '99+' : $unreadDms}
          </span>
        {/if}
      </button>
      <!-- Identity, demoted from a strip and a switcher above the feed to the one control that
           opens all of it. -->
      <button
        type="button"
        class="duration-short ease-standard rounded-full transition-transform hover:scale-105"
        onclick={() => (menu = true)}
        title="Posting as @{$activeAccount?.handle ?? ''}"
        aria-label="Posting as @{$activeAccount?.handle ?? ''}"
      >
        <Avatar
          initials={($activeAccount?.handle ?? '?').slice(0, 2).toUpperCase()}
          src={$activeAccount?.avatar ?? ''}
          size="w-7 h-7"
          textClass="text-label-small"
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
    <div
      class="animate-in fade-in bg-surface duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col"
    >
      <Composer
        handle={$activeAccount?.handle}
        initial={editing?.body ?? ''}
        placeholder={editing ? 'Fix a typo' : "What's happening?"}
        busy={$busy}
        allowAttachments={!editing}
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
    <div
      class="animate-in fade-in bg-surface duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col"
    >
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
        // A main and an alt follow different people, so the Following feed belongs to the account
        // rather than to the phone — switching identity has to refetch it.
        if (tab === 'following') void loadFollowing();
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

  {#if onTabs}
    <!-- `raised` so it clears the nav they share this snippet with. -->
    <FloatingActionButton label="Blab" collapsed raised onclick={() => (composing = true)}>
      {#snippet icon()}
        <AddIcon class="text-on-surface size-icon-sm shrink-0" />
      {/snippet}
    </FloatingActionButton>

    <TabBar
      aria-label="Blabber sections"
      selected={tab}
      onchange={selectTab}
      options={[
        { id: 'feed', label: 'Feed', icon: HomeIcon },
        { id: 'following', label: 'Following', icon: UsersIcon },
        { id: 'notifications', label: 'Notifications', icon: BellIcon },
        { id: 'search', label: 'Search', icon: SearchIcon }
      ]}
    />
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
      ontag={openTag}
    />
  {:else if view === 'thread' && activeBlabId !== null}
    <BlabDetail
      blabId={activeBlabId}
      anchorId={activeAnchorId}
      handle={$activeAccount?.handle}
      busy={$busy}
      onhandle={openProfile}
      ontag={openTag}
      onmouth={mouth}
      onear={ear}
    />
  {:else if view === 'tag' && activeTag}
    <TaggedFeed
      tag={activeTag}
      onhandle={openProfile}
      ontag={openTag}
      onopen={(b) => openBlab(b.id)}
      onmouth={mouth}
      onear={ear}
    />
  {:else if view === 'follows' && follows}
    <FollowList
      accountId={follows.account.id}
      kind={follows.kind}
      handle={follows.account.handle}
      onhandle={openProfile}
    />
  {:else if view === 'profile' && profileHandle}
    <Profile
      handle={profileHandle}
      onhandle={openProfile}
      onmessage={(account) => openDms(account.id, account)}
      onfollows={openFollows}
    />
  {:else if !$accountsLoaded}
    <div class="p-4"><Skeleton count={4} height="h-16" /></div>
  {:else if $myAccounts.length === 0}
    <!-- Nothing to post from yet. Told, rather than shown an empty feed and a dead composer. -->
    <ClaimHandle busy={$busy} onclaim={claim} />
  {:else if tab === 'notifications'}
    <NotificationsTab onopenblab={openBlab} onopenhandle={openProfile} />
  {:else if tab === 'search'}
    <Search
      onhandle={openProfile}
      ontag={openTag}
      onopen={(id, anchorId) => openBlab(id, anchorId)}
    />
  {:else if tab === 'following'}
    <!-- `pb-20` clears the nav and safe bottom inset: without it the last row hides underneath the bar. -->
    <div class="flex-1 overflow-y-auto pb-20" onscroll={followingPage.onScroll}>
      {#if !$followingLoaded}
        <div class="p-4"><Skeleton count={4} height="h-16" /></div>
      {:else if $followingFeed.length === 0}
        <!-- Two different statements, and the app has to pick the right one: nobody followed yet
             versus followed people who have not posted. -->
        <EmptyState
          title="Nothing from anyone yet"
          description="Follow somebody from their profile and their Blabs turn up here."
        />
      {:else}
        {#each followingPage.visible as blab (blab.id)}
          <BlabRow
            {blab}
            editable={isMine(blab)}
            stats={$engagement[blab.id]}
            onhandle={openProfile}
            ontag={openTag}
            onedit={(b) => (editing = b)}
            ondelete={remove}
            onreply={(b) => openBlab(b.id)}
            onmouth={mouth}
            onear={ear}
            onopen={(b) => openBlab(b.id)}
          />
        {/each}
        {#if followingPage.loading}
          <div class="p-4"><Skeleton count={2} height="h-16" /></div>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="flex-1 overflow-y-auto pb-20" onscroll={page.onScroll}>
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
            ontag={openTag}
            onedit={(b) => (editing = b)}
            ondelete={remove}
            onreply={(b) => openBlab(b.id)}
            onmouth={mouth}
            onear={ear}
            onopen={(b) => openBlab(b.id)}
          />
        {/each}
        {#if page.loading}
          <div class="p-4"><Skeleton count={2} height="h-16" /></div>
        {/if}
      {/if}
    </div>
  {/if}
</Screen>
