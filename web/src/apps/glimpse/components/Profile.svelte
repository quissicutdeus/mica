<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Avatar,
    Button,
    EmptyPhotoIcon,
    EmptyState,
    MediaThumb,
    ReportButton,
    ReportDialog,
    Skeleton,
    useAppAction,
    useLocale
  } from '@mica/sdk';
  import type { Account, GlimpsePost } from '@mica/shared/types';
  import {
    activeAccount,
    findAccount,
    followStats,
    loadFollowStats,
    loadProfilePage,
    myAccounts,
    toggleFollow
  } from '../store';

  /**
   * One account's grid: who they are, their counts, then their posts three across.
   *
   * The handle is resolved to an account through the `accounts` facet's public read, then the
   * grid comes from `glimpse:profile` as the active account sees it — a viewer who blocked the
   * account gets it with no posts. Each square is the post's first photo; tapping it opens the
   * post, where the rest of the carousel is.
   */
  let {
    handle,
    onopen,
    onedit,
    onmessage
  }: {
    handle: string;
    onopen: (post: GlimpsePost) => void;
    /** Edit the display half of my own identity. Offered on a profile that is mine. */
    onedit?: () => void;
    /** Open a direct-message thread with this account. Offered on someone else's profile. */
    onmessage?: (account: Account) => void;
  } = $props();

  const { t } = useLocale();
  const { run, busy } = useAppAction('glimpse');

  let account = $state<Account | null>(null);
  let rows = $state<GlimpsePost[]>([]);
  let cursor = $state<number | null>(null);
  let loading = $state(true);
  /** The handle answered with nobody. A failed read is not this: it keeps the skeleton. */
  let notFound = $state(false);
  let reporting = $state(false);

  const mine = $derived($myAccounts.some((a) => a.handle === handle));
  const stats = $derived(account ? $followStats[account.id] : undefined);

  const loadPage = async (from: number | null) => {
    if (!account) return;
    loading = true;
    try {
      const reply = await loadProfilePage(account.id, from);
      if (!reply || !Array.isArray(reply.rows)) {
        throw new Error('glimpse:profile answered without rows');
      }
      rows = from === null ? reply.rows : [...rows, ...reply.rows];
      cursor = typeof reply.nextCursor === 'number' ? reply.nextCursor : null;
    } catch (error) {
      console.warn("micaOS Glimpse: could not load this profile's posts", error);
    } finally {
      loading = false;
    }
  };

  const load = async () => {
    loading = true;
    let found: Account | null;
    try {
      found = await findAccount(handle);
    } catch (error) {
      console.warn('micaOS Glimpse: could not load this profile', error);
      return;
    }
    account = found;
    if (!found) {
      notFound = true;
      loading = false;
      return;
    }
    await loadFollowStats(found.id).catch((error) => {
      console.warn('micaOS Glimpse: could not load follow counts', error);
    });
    await loadPage(null);
  };

  $effect(() => {
    void handle;
    account = null;
    rows = [];
    cursor = null;
    notFound = false;
    void load();
  });

  const onScroll = (event: Event) => {
    const el = event.target as HTMLElement;
    if (cursor === null || loading) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 40) void loadPage(cursor);
  };

  const follow = () => {
    const target = account;
    if (!target) return;
    void run(() => toggleFollow(target.id), { title: $t('glimpse.title') });
  };
</script>

<div class="flex min-h-0 flex-1 flex-col">
  {#if notFound}
    <EmptyState
      title={$t('glimpse.noHandle')}
      description={$t('glimpse.noHandleHint', { handle })}
    />
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto pb-home-indicator" onscroll={onScroll}>
      <div class="flex items-center gap-4 p-4">
        <Avatar
          src={account?.avatar ?? undefined}
          initials={handle.slice(0, 2).toUpperCase()}
          size="w-16 h-16"
          showSilhouette={false}
        />
        <div class="min-w-0 flex-1">
          <p class="text-on-surface text-body-large truncate font-semibold">
            {account?.display_name || handle}
          </p>
          <p class="text-on-surface-variant text-body-small truncate">
            @{handle}{mine ? $t('glimpse.youSuffix') : ''}
          </p>
          {#if stats}
            <p class="text-on-surface-variant text-body-small mt-1 flex gap-3">
              <span data-testid="glimpse-followers">
                <span class="text-on-surface font-semibold">{stats.followers}</span>
                {$t('glimpse.followersLabel')}
              </span>
              <span>
                <span class="text-on-surface font-semibold">{stats.following}</span>
                {$t('glimpse.followingLabel')}
              </span>
            </p>
          {/if}
        </div>
      </div>

      {#if account?.bio}
        <p class="text-on-surface text-body-small px-4 pb-3 break-words whitespace-pre-wrap">
          {account.bio}
        </p>
      {/if}

      {#if account}
        <div class="flex items-center gap-2 px-4 pb-3">
          {#if mine}
            {#if onedit}
              <Button variant="secondary" class="text-body-small flex-1 py-1.5" onclick={onedit}>
                {$t('glimpse.editProfile')}
              </Button>
            {/if}
          {:else}
            {#if $activeAccount}
              <Button
                variant={stats?.followedByMe ? 'secondary' : 'primary'}
                class="text-body-small flex-1 py-1.5"
                disabled={$busy}
                onclick={follow}
              >
                {stats?.followedByMe ? $t('glimpse.followingButton') : $t('glimpse.follow')}
              </Button>
              {#if onmessage}
                <Button
                  variant="secondary"
                  class="text-body-small flex-1 py-1.5"
                  data-testid="glimpse-message"
                  onclick={() => account && onmessage(account)}
                >
                  {$t('glimpse.message')}
                </Button>
              {/if}
            {/if}
            <ReportButton subject="account" onclick={() => (reporting = true)} />
          {/if}
        </div>
      {/if}

      <div class="border-outline-variant border-t">
        {#if loading && rows.length === 0}
          <div class="p-4"><Skeleton count={3} height="h-24" /></div>
        {:else if rows.length === 0}
          <EmptyState
            title={$t('glimpse.noPostsYet')}
            description={mine ? $t('glimpse.noPostsYetMine') : $t('glimpse.noPostsYetHint')}
          />
        {:else}
          <div class="grid grid-cols-3 gap-px" data-testid="glimpse-grid">
            {#each rows as post (post.id)}
              <button
                type="button"
                class="bg-surface-container relative aspect-square cursor-pointer overflow-hidden"
                aria-label={$t('glimpse.openPost', { handle })}
                data-post-id={post.id}
                onclick={() => onopen(post)}
              >
                {#if post.attachments[0]}
                  <MediaThumb item={post.attachments[0].media} />
                {:else}
                  <span
                    class="text-on-surface-variant flex h-full w-full items-center justify-center"
                  >
                    <EmptyPhotoIcon class="size-icon-md" />
                  </span>
                {/if}
              </button>
            {/each}
          </div>
          {#if loading}
            <div class="p-4"><Skeleton count={1} height="h-24" /></div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if reporting && account}
  <ReportDialog
    targetTable="mica_accounts"
    targetId={account.id}
    appId="glimpse"
    onclose={() => (reporting = false)}
  />
{/if}
