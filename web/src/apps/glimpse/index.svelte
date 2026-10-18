<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { get } from 'svelte/store';
  import {
    AddIcon,
    Avatar,
    ConfirmDialog,
    EmptyState,
    FloatingActionButton,
    HomeIcon,
    MessageIcon,
    Screen,
    Skeleton,
    TabBar,
    UsersIcon,
    onAppForeground,
    registerMessages,
    useAppAction,
    useAppEvents,
    useAppLevels,
    useDeepLink,
    useLocale,
    usePagedList,
    type AppProps
  } from '@mica/sdk';
  import type { GlimpsePost } from '@mica/shared/types';
  import {
    accountLimit,
    accountsLoaded,
    activeAccount,
    activeAccountId,
    canClaimAnother,
    claimAccount,
    createPost,
    deletePost,
    editCaption,
    editWindow,
    engagement,
    feed,
    findAccount,
    followingFeed,
    likes,
    loadEngagement,
    loadFeed,
    loadFollowing,
    loadLikes,
    loadMyAccounts,
    myAccounts,
    toggleLike,
    updateAccount,
    type GlimpsePeer
  } from './store';
  import AccountMenu from './components/AccountMenu.svelte';
  import ClaimHandle from './components/ClaimHandle.svelte';
  import Composer from './components/Composer.svelte';
  import EditProfile from './components/EditProfile.svelte';
  import Messages from './components/Messages.svelte';
  import PostCard from './components/PostCard.svelte';
  import PostDetail from './components/PostDetail.svelte';
  import Profile from './components/Profile.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // A `core: false` add-on ships its own catalog and reads every label through `$t('glimpse.…')`.
  registerMessages('glimpse', { en, de });
  const { t } = useLocale();

  /**
   * Deep links: `glimpse?postId=<id>` (a comment or a mention), `glimpse?handle=<h>`, and
   * `glimpse?dmHandle=<h>` (a direct message, MICA-393).
   */
  let {
    onback,
    postId,
    handle,
    dmHandle
  }: AppProps & {
    postId?: number;
    handle?: string | number;
    dmHandle?: string | number;
  } = $props();

  const { run, busy } = useAppAction('glimpse');

  const feedLoaded = feed.loaded;
  const feedHasMore = feed.hasMore;
  const followingLoaded = followingFeed.loaded;
  const followingHasMore = followingFeed.hasMore;

  /** The overlay stack above the tabs. */
  let view = $state<'feed' | 'profile' | 'post' | 'dm'>('feed');
  /** Which destination the bottom nav is on. */
  let tab = $state<'feed' | 'following' | 'messages'>('feed');
  /** Who the open DM thread is with, when `view` is `dm`. */
  let dmPeer = $state<GlimpsePeer | null>(null);
  /** A thread opened from a profile goes back to it; one from the inbox, to the inbox. */
  let dmFromProfile = $state(false);
  let activePostId = $state<number | null>(null);
  let profileHandle = $state<string | null>(null);
  let composing = $state(false);
  /** The post whose caption is being edited, or null. Shares the composer overlay. */
  let editing = $state<GlimpsePost | null>(null);
  let confirmingDelete = $state<GlimpsePost | null>(null);
  let menu = $state(false);
  let editingProfile = $state(false);
  let claiming = $state(false);
  /** A post opened from a profile's grid comes back to that grid, not the feed. */
  let returnToProfile = $state(false);
  /** Bumped after a caption edit, so an open detail screen re-reads its post. */
  let postVersion = $state(0);

  /**
   * Every visit, not once per session — the app is resident, so `onMount` would show whatever
   * was true the first time it was ever opened (§11).
   */
  onAppForeground('glimpse', () => {
    void loadMyAccounts().then(() => {
      void loadFeed();
      if (tab === 'following') void loadFollowing();
    });
  });

  const page = usePagedList<GlimpsePost>({
    items: () => $feed,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: () => feed.loadMore(),
    hasMore: () => $feedHasMore
  });

  const followingPage = usePagedList<GlimpsePost>({
    items: () => $followingFeed,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: () => followingFeed.loadMore(),
    hasMore: () => $followingHasMore
  });

  const selectTab = (next: string) => {
    if (next !== 'feed' && next !== 'following' && next !== 'messages') return;
    tab = next;
    if (tab === 'following') void loadFollowing();
  };

  /**
   * A comment or mention arriving while the app is on screen: refresh the counts in front of the
   * player. A replay on mount is a catch-up, and `onAppForeground` already reloads for it.
   */
  const events = useAppEvents('glimpse');
  const refreshVisible = () => {
    const visible = tab === 'following' ? followingPage.visible : page.visible;
    const ids = visible.map((post) => post.id);
    if (ids.length > 0) void loadEngagement(ids).catch(() => undefined);
  };
  events.on('comment', (event) => {
    if (!event.replayed) refreshVisible();
  });
  events.on('mention', (event) => {
    if (!event.replayed) void loadFeed();
  });

  const openProfile = (next: string) => {
    profileHandle = next;
    view = 'profile';
  };

  /**
   * Open a thread. An inbox row has no avatar, so the header asks the accounts read for one —
   * dropped if the player has moved to another thread by the time it answers.
   */
  const openDm = (peer: GlimpsePeer, fromProfile = false) => {
    dmPeer = peer;
    dmFromProfile = fromProfile;
    view = 'dm';
    if (peer.avatar !== undefined || !peer.handle) return;
    void findAccount(peer.handle)
      .then((account) => {
        if (account && dmPeer?.id === account.id) dmPeer = { ...dmPeer, avatar: account.avatar };
      })
      .catch(() => undefined);
  };

  /**
   * `glimpse?dmHandle=<h>`: the handle is resolved to an account, since a thread is keyed by the
   * peer's id. Opened over the Messages tab, so Back lands in the inbox. A handle nobody holds,
   * or one of the player's own, leaves the inbox showing rather than a thread that cannot exist.
   */
  const openDmByHandle = async (target: string) => {
    tab = 'messages';
    view = 'feed';
    const account = await findAccount(target).catch(() => null);
    if (!account || mineIds.has(account.id)) return;
    openDm(account);
  };

  const openPost = (post: GlimpsePost | number) => {
    activePostId = typeof post === 'number' ? post : post.id;
    view = 'post';
  };

  useDeepLink('glimpse', () => {
    if (postId) {
      openPost(Number(postId));
      return true;
    }
    if (handle !== undefined && handle !== '') {
      // A digit-only handle arrives as a number: `parseDeepLink` converts it.
      openProfile(String(handle));
      return true;
    }
    if (dmHandle !== undefined && dmHandle !== '') {
      // Resolved after the fact: `findAccount` answers whether or not the inbox has loaded.
      void openDmByHandle(String(dmHandle));
      return true;
    }
    return false;
  });

  /**
   * Comment counts and likes for whatever window is on screen — one batched read each per
   * window, never one per post.
   */
  $effect(() => {
    const visible = tab === 'following' ? followingPage.visible : page.visible;
    const ids = visible.map((post) => post.id);
    if (ids.length === 0) return;
    void loadEngagement(ids).catch((error) => {
      console.warn('micaOS Glimpse: could not load comment counts', error);
    });
    void loadLikes(ids);
  });

  const mineIds = $derived(new Set($myAccounts.map((account) => account.id)));
  const isMine = (post: GlimpsePost) => mineIds.has(post.account_id);

  /** Mine, and inside the edit window. A courtesy: the `UPDATE`'s predicate is the boundary. */
  const canEdit = (post: GlimpsePost) =>
    isMine(post) && Date.now() - new Date(post.created_at).getTime() < get(editWindow) * 1000;

  const like = (post: GlimpsePost) =>
    void run(() => toggleLike(post.id), { title: $t('glimpse.title') });

  const closeComposer = () => {
    composing = false;
    editing = null;
  };

  const submitComposer = async (caption: string, attachments: { photo_id: number }[]) => {
    const target = editing;
    if (target) {
      const ok = await run(() => editCaption(target, caption), {
        title: $t('glimpse.title'),
        success: $t('glimpse.updated')
      });
      if (ok) {
        closeComposer();
        postVersion += 1;
      }
      return;
    }
    const ok = await run(() => createPost(caption, attachments), {
      title: $t('glimpse.title'),
      success: $t('glimpse.posted')
    });
    if (ok) closeComposer();
  };

  const confirmDelete = async () => {
    const target = confirmingDelete;
    if (!target) return;
    const ok = await run(() => deletePost(target.id), {
      title: $t('glimpse.title'),
      success: $t('glimpse.deleted')
    });
    confirmingDelete = null;
    if (ok && view === 'post' && activePostId === target.id) {
      activePostId = null;
      view = 'feed';
    }
  };

  const claim = async (next: string): Promise<void> => {
    if (
      await run(() => claimAccount(next), {
        title: $t('glimpse.title'),
        success: $t('glimpse.handleClaimed')
      })
    ) {
      claiming = false;
      void loadFeed();
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
        title: $t('glimpse.title'),
        success: $t('glimpse.profileUpdated')
      })
    ) {
      editingProfile = false;
    }
  };

  const app = useAppLevels({
    appId: 'glimpse',
    title: () => $t('glimpse.title'),
    onback: () => onback(),
    levels: [
      // Deepest first; every overlay its own rung, so Back closes it rather than leaving.
      { open: () => confirmingDelete !== null, close: () => (confirmingDelete = null) },
      {
        open: () => composing || editing !== null,
        close: closeComposer,
        title: () => (editing ? $t('glimpse.editCaption') : $t('glimpse.newPost'))
      },
      {
        open: () => editingProfile,
        close: () => (editingProfile = false),
        title: () => $t('glimpse.editProfile')
      },
      {
        open: () => claiming,
        close: () => (claiming = false),
        title: () => $t('glimpse.newHandle')
      },
      { open: () => menu, close: () => (menu = false), title: () => $t('glimpse.postingAs') },
      {
        open: () => view === 'post',
        close: () => {
          activePostId = null;
          view = profileHandle && returnToProfile ? 'profile' : 'feed';
          returnToProfile = false;
        },
        title: () => $t('glimpse.post')
      },
      {
        open: () => view === 'dm',
        close: () => {
          dmPeer = null;
          view = dmFromProfile && profileHandle ? 'profile' : 'feed';
          dmFromProfile = false;
        },
        title: () => (dmPeer ? dmPeer.display_name || `@${dmPeer.handle}` : $t('glimpse.message'))
      },
      {
        open: () => view === 'profile',
        close: () => (view = 'feed'),
        title: () => (profileHandle ? `@${profileHandle}` : $t('glimpse.profile'))
      },
      {
        open: () => tab !== 'feed',
        close: () => (tab = 'feed'),
        title: () => (tab === 'messages' ? $t('glimpse.messages') : $t('glimpse.following'))
      }
    ]
  });

  const openFromGrid = (post: GlimpsePost) => {
    returnToProfile = true;
    openPost(post);
  };

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
  {#if view === 'feed' && $accountsLoaded && $myAccounts.length > 0}
    <div class="ml-auto flex items-center gap-1">
      <button
        type="button"
        class="duration-short ease-standard rounded-full transition-transform hover:scale-105"
        onclick={() => (menu = true)}
        title={$t('glimpse.postingAsHandle', { handle: $activeAccount?.handle ?? '' })}
        aria-label={$t('glimpse.postingAsHandle', { handle: $activeAccount?.handle ?? '' })}
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

{#snippet feedList(
  rows: GlimpsePost[],
  loaded: boolean,
  loadingMore: boolean,
  onScroll: (event: Event) => void,
  emptyTitle: string,
  emptyHint: string
)}
  <!-- `pb-20` clears the nav and the home indicator under it. -->
  <div class="min-h-0 flex-1 overflow-y-auto pb-20" onscroll={onScroll} data-testid="glimpse-feed">
    {#if !loaded}
      <div class="p-4"><Skeleton count={2} height="h-64" /></div>
    {:else if rows.length === 0}
      <EmptyState title={emptyTitle} description={emptyHint} />
    {:else}
      {#each rows as post (post.id)}
        <PostCard
          {post}
          mine={isMine(post)}
          canEdit={canEdit(post)}
          likes={$likes[post.id]}
          stats={$engagement[post.id]}
          onhandle={openProfile}
          onlike={like}
          onopen={openPost}
          onedit={(p: GlimpsePost) => (editing = p)}
          ondelete={(p: GlimpsePost) => (confirmingDelete = p)}
        />
      {/each}
      {#if loadingMore}
        <div class="p-4"><Skeleton count={1} height="h-64" /></div>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet overlays()}
  {#if composing || editing}
    <!-- `pt-safe-top`: `inset-0` covers the header, and with it the only status-bar inset. -->
    <div
      class="pt-safe-top animate-in fade-in bg-surface duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col"
    >
      <Composer
        handle={$activeAccount?.handle}
        editing={editing !== null}
        initial={editing?.caption ?? ''}
        busy={$busy}
        onsubmit={(caption: string, attachments: { photo_id: number }[]) =>
          void submitComposer(caption, attachments)}
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
      class="pt-safe-top animate-in fade-in bg-surface duration-medium ease-emphasized absolute inset-0 z-30 flex flex-col"
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
      onswitch={(id: number) => {
        activeAccountId.set(id);
        menu = false;
        // Blocks and follows belong to the account, so both feeds answer differently now.
        void loadFeed();
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
      onprofile={() => {
        menu = false;
        if ($activeAccount) openProfile($activeAccount.handle);
      }}
      onclose={() => (menu = false)}
    />
  {/if}

  {#if confirmingDelete}
    <ConfirmDialog
      title={$t('glimpse.deletePostTitle')}
      message={$t('glimpse.deletePostMessage')}
      confirmText={$t('glimpse.delete')}
      isLoading={$busy}
      onconfirm={() => void confirmDelete()}
      oncancel={() => (confirmingDelete = null)}
    />
  {/if}

  {#if onTabs && tab !== 'messages'}
    <FloatingActionButton
      label={$t('glimpse.newPost')}
      collapsed
      raised
      onclick={() => (composing = true)}
    >
      {#snippet icon()}
        <AddIcon class="text-on-surface size-icon-sm shrink-0" />
      {/snippet}
    </FloatingActionButton>
  {/if}

  {#if onTabs}
    <TabBar
      aria-label={$t('glimpse.sections')}
      selected={tab}
      onchange={selectTab}
      options={[
        { id: 'feed', label: $t('glimpse.forYou'), icon: HomeIcon },
        { id: 'following', label: $t('glimpse.following'), icon: UsersIcon },
        { id: 'messages', label: $t('glimpse.messages'), icon: MessageIcon }
      ]}
    />
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions} overlay={overlays}>
  {#if view === 'post' && activePostId !== null}
    <PostDetail
      postId={activePostId}
      version={postVersion}
      {canEdit}
      onhandle={openProfile}
      onlike={like}
      onedit={(p: GlimpsePost) => (editing = p)}
      ondelete={(p: GlimpsePost) => (confirmingDelete = p)}
    />
  {:else if view === 'dm' && dmPeer && $activeAccount}
    <Messages
      accountId={$activeAccount.id}
      peer={dmPeer}
      onopen={(peer: GlimpsePeer) => openDm(peer)}
      onhandle={openProfile}
    />
  {:else if view === 'profile' && profileHandle}
    <Profile
      handle={profileHandle}
      onopen={openFromGrid}
      onedit={() => (editingProfile = true)}
      onmessage={(account: GlimpsePeer) => openDm(account, true)}
    />
  {:else if !$accountsLoaded}
    <div class="p-4"><Skeleton count={2} height="h-64" /></div>
  {:else if $myAccounts.length === 0}
    <!-- Nothing to post, like or comment from yet. Told, rather than shown a dead feed. -->
    <ClaimHandle busy={$busy} onclaim={claim} />
  {:else if tab === 'messages' && $activeAccount}
    <Messages
      accountId={$activeAccount.id}
      onopen={(peer: GlimpsePeer) => openDm(peer)}
      onhandle={openProfile}
    />
  {:else if tab === 'following'}
    {@render feedList(
      followingPage.visible,
      $followingLoaded,
      followingPage.loading,
      followingPage.onScroll,
      $t('glimpse.followingEmpty'),
      $t('glimpse.followingEmptyHint')
    )}
  {:else}
    {@render feedList(
      page.visible,
      $feedLoaded,
      page.loading,
      page.onScroll,
      $t('glimpse.feedEmpty'),
      $t('glimpse.feedEmptyHint')
    )}
  {/if}
</Screen>
