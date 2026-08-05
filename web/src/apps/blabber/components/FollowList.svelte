<script lang="ts">
  import { Avatar, EmptyState, ListItem, Skeleton, useBlabber, usePagedList } from '@gphone/sdk';
  import type { Account } from '@shared/types';

  /**
   * Who follows an account, or who it follows.
   *
   * One component for both directions rather than two nearly identical files: the only thing that
   * differs is which store it reads and what an empty one means, and a copy would be two places to
   * fix the next time a row grows a field.
   *
   * There is deliberately **no Follow button on a row.** The button needs this viewer's follow state
   * for every account on screen, and thirty rows asking individually is the round-trip storm the
   * batched `engagement` read exists to avoid. A row opens the profile, which already owns the
   * button and the counts — so the affordance exists, one tap further in, and the list stays a list.
   */
  let {
    accountId,
    kind,
    handle,
    onhandle
  }: {
    accountId: number;
    kind: 'followers' | 'following';
    /** Whose list this is, for an empty state that can name them. */
    handle: string;
    onhandle: (handle: string) => void;
  } = $props();

  const { followers, following, loadFollowers, loadFollowingList } = useBlabber();

  const store = $derived(kind === 'followers' ? followers : following);

  /**
   * A window over a server-paged list, `olderAt: 'end'` like the feeds: older rows are below and
   * revealing them cannot move what the reader is looking at.
   */
  const page = usePagedList<Account>({
    items: () => rows,
    olderAt: 'end',
    pageSize: 30,
    loadOlder: () => store.loadMore(),
    hasMore: () => hasMore
  });

  let rows = $state<Account[]>([]);
  let hasMore = $state(false);
  let loaded = $state(false);

  /**
   * Subscribed rather than read with `$store`, because which store this is depends on `kind` — the
   * auto-subscription syntax needs a name fixed at compile time. Re-subscribing when `kind` or the
   * account changes, and the unsubscribes are returned so switching lists does not leave the old
   * one feeding this component.
   */
  $effect(() => {
    const current = store;
    const stops = [
      current.subscribe((value) => (rows = value)),
      current.hasMore.subscribe((value) => (hasMore = value)),
      current.loaded.subscribe((value) => (loaded = value))
    ];
    return () => stops.forEach((stop) => stop());
  });

  /**
   * Fetched on open and on every change of subject, not in `onAppForeground` — this is a screen
   * inside the app rather than the app's own load, and it exists only while it is on screen. The
   * app-level rule is about an app showing stale data for a whole session; a list that is created
   * when you tap a count cannot.
   */
  $effect(() => {
    const id = accountId;
    if (kind === 'followers') void loadFollowers(id);
    else void loadFollowingList(id);
  });
</script>

<div class="flex-1 overflow-y-auto" onscroll={page.onScroll}>
  {#if !loaded}
    <div class="p-4"><Skeleton count={4} height="h-14" /></div>
  {:else if rows.length === 0}
    <!-- Two different sentences, because they are two different facts about the same empty list. -->
    <EmptyState
      title={kind === 'followers' ? 'No followers yet' : 'Not following anyone'}
      description={kind === 'followers'
        ? `Nobody follows @${handle} yet.`
        : `@${handle} has not followed anybody yet.`}
    />
  {:else}
    {#each page.visible as account (account.id)}
      <ListItem onclick={() => onhandle(account.handle)} class="gap-3">
        <Avatar
          src={account.avatar ?? undefined}
          initials={account.handle.slice(0, 2).toUpperCase()}
          size="w-10 h-10"
          showSilhouette={false}
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-white">
            {account.display_name || account.handle}
          </p>
          <p class="truncate text-xs text-gray-500">@{account.handle}</p>
          {#if account.bio}
            <p class="mt-0.5 line-clamp-2 text-xs text-gray-400">{account.bio}</p>
          {/if}
        </div>
      </ListItem>
    {/each}
    {#if page.loading}
      <div class="p-4"><Skeleton count={2} height="h-14" /></div>
    {/if}
  {/if}
</div>
