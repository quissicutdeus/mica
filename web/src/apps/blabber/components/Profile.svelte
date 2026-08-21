<script lang="ts">
  import {
    Avatar,
    Button,
    EmptyState,
    MessageIcon,
    ReportButton,
    ReportDialog,
    SegmentedControl,
    Skeleton,
    useAccounts,
    useAppAction,
    useService
  } from '@gphone/sdk';
  import { useBlabber } from '../store';
  import type { Account, Blab } from '@shared/types';
  import BlabRow from './BlabRow.svelte';

  /**
   * One account's public profile: who they are, then their Blabs or their replies.
   *
   * Two tabs rather than one merged list, because they answer different questions — "what does
   * this person post" and "what are they arguing about". The split is server-side
   * (`reply_to IS NULL` / `IS NOT NULL`) so each tab pages independently; filtering one fetched
   * list client-side would be wrong the moment a page happened to be all replies.
   */
  /**
   * `onmessage` is what makes a DM reachable from a profile — the DM empty state has always told
   * players to "tap a handle to start a conversation" and no code path implemented it, because
   * the inbox was the only way in and the inbox only lists threads that already exist.
   */
  let {
    handle,
    onhandle,
    onmessage,
    onfollows
  }: {
    handle: string;
    onhandle?: (handle: string) => void;
    onmessage?: (account: Account) => void;
    /**
     * What the counts became. They were plain text with a comment saying so — an honest number
     * rather than a link to a screen that did not exist — and now that the screen exists, the
     * number is the way in.
     */
    onfollows?: (account: Account, kind: 'followers' | 'following') => void;
  } = $props();

  const { myAccounts, followStats, loadFollowStats, toggleFollow, toggleBlock, activeAccount } =
    useBlabber();
  const { getAccounts } = useAccounts();
  const { run, busy } = useAppAction('blabber');

  let account = $state<Account | null>(null);
  let tab = $state<'blabs' | 'replies'>('blabs');
  let rows = $state<Blab[]>([]);
  let cursor = $state<number | null>(null);
  let loading = $state(true);

  const mine = $derived($myAccounts.some((a) => a.handle === handle));

  /**
   * The account behind the handle, through the public read.
   *
   * `handle` is `clientFilterable`, so this is the generic paged `get` with a filter rather than
   * a bespoke endpoint. It cannot return the owner's citizenid — a public projection withholds
   * it, which on a profile page is the single most useful field for correlating an alt back to
   * whoever owns it.
   */
  const loadAccount = async () => {
    const reply = await getAccounts({ app: 'blabber', handle, limit: 1 });
    account = reply.rows?.[0] ?? null;
    // Counts come from the graph rather than from a column on the account: a stored
    // `follower_count` is a second copy of a fact `gphone_account_follows` already holds.
    if (account) await loadFollowStats(account.id);
  };

  /**
   * This account's standing in the graph, keyed by id like `engagement` is keyed by Blab — so
   * coming back to a profile shows what it showed before rather than blanking while it refetches.
   */
  const stats = $derived(account ? $followStats[account.id] : undefined);

  /** The two counts, so the markup below renders one row shape rather than two copies of it. */
  const counts = $derived(
    stats
      ? ([
          { kind: 'followers', count: stats.followers, label: 'followers' },
          { kind: 'following', count: stats.following, label: 'following' }
        ] as const)
      : []
  );

  /** Following acts as the *active* account, which is what the server verifies. */
  const follow = () => {
    const target = account;
    if (!target) return;
    void run(() => toggleFollow(target.id), { title: 'Blabber' });
  };

  /**
   * Blocking acts as the *active* account too. One-directional: this account is never told,
   * and the only visible effect on this screen is the button's own label flipping.
   */
  const block = () => {
    const target = account;
    if (!target) return;
    void run(() => toggleBlock(target.id), { title: 'Blabber' }).then(() => loadPage(null));
  };

  const loadPage = async (from: number | null) => {
    if (!account) return;
    loading = true;
    try {
      // Through the app's own service, like everything else Blabber owns — so this needs
      // no row in the core route table.
      const reply = await useService('blabber').call<{ rows: Blab[]; nextCursor: number | null }>(
        'profile',
        {
          account_id: account.id,
          tab,
          cursor: from ?? undefined,
          viewer_account_id: $activeAccount?.id
        },
        { rows: [], nextCursor: null }
      );
      rows = from === null ? reply.rows : [...rows, ...reply.rows];
      cursor = reply.nextCursor;
    } finally {
      loading = false;
    }
  };

  const onScroll = (event: Event) => {
    const el = event.target as HTMLElement;
    if (cursor === null || loading) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 40) void loadPage(cursor);
  };

  // Reload from the top whenever the handle or the tab changes. Both replace the list rather
  // than appending, so the cursor has to reset with them.
  $effect(() => {
    void handle;
    account = null;
    rows = [];
    cursor = null;
    void loadAccount().then(() => loadPage(null));
  });

  $effect(() => {
    void tab;
    if (account) {
      rows = [];
      cursor = null;
      void loadPage(null);
    }
  });

  /** Reporting the account itself, as opposed to any one of its Blabs. */
  let reporting = $state(false);
</script>

<div class="flex h-full flex-col">
  <div class="border-outline-variant flex items-center gap-3 border-b p-4">
    <Avatar
      src={account?.avatar ?? undefined}
      initials={handle.slice(0, 2).toUpperCase()}
      size="w-14 h-14"
      showSilhouette={false}
    />
    <div class="min-w-0">
      <p class="text-on-surface text-body-large truncate">
        {account?.display_name || handle}
      </p>
      <p class="text-on-surface-variant text-body-small truncate">
        @{handle}{mine ? ' · you' : ''}
      </p>
      {#if account?.bio}
        <p class="text-on-surface text-body-small mt-1">{account.bio}</p>
      {/if}
      {#if stats}
        <!-- Buttons now that there is somewhere to go. `onfollows` is optional, so a caller that
             has no list screen still gets the numbers rather than a dead control — and the markup
             says which it is, because a count that looks tappable and is not is the same broken
             promise the other way round. -->
        <p class="text-on-surface-variant text-body-small mt-1 flex gap-3">
          {#each counts as entry (entry.kind)}
            {#if onfollows && account}
              <button
                type="button"
                class="hover:text-on-surface"
                onclick={() => account && onfollows(account, entry.kind)}
              >
                <span class="text-on-surface font-semibold">{entry.count}</span>
                {entry.label}
              </button>
            {:else}
              <span>
                <span class="text-on-surface font-semibold">{entry.count}</span>
                {entry.label}
              </span>
            {/if}
          {/each}
        </p>
      {/if}
    </div>
    <!-- Not on your own profile: a DM to yourself is a thread with one participant, which the
         1:1 shape has no room for, and following yourself is refused server-side. -->
    {#if account && !mine}
      <div class="ml-auto flex shrink-0 items-center gap-2">
        {#if $activeAccount}
          <Button
            variant={stats?.followedByMe ? 'secondary' : 'primary'}
            class="text-body-small px-3 py-1.5"
            disabled={$busy}
            onclick={follow}
          >
            {stats?.followedByMe ? 'Following' : 'Follow'}
          </Button>
          <Button
            variant="secondary"
            class="text-body-small px-3 py-1.5"
            disabled={$busy}
            onclick={block}
          >
            {stats?.blockedByMe ? 'Unblock' : 'Block'}
          </Button>
        {/if}
        {#if onmessage}
          <button
            type="button"
            class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover duration-short ease-standard rounded-full p-2 transition-colors"
            onclick={() => account && onmessage(account)}
            title="Message @{handle}"
            aria-label="Message @{handle}"
          >
            <MessageIcon class="size-icon-sm" />
          </button>
        {/if}
        <!-- Somebody else's profile only. An account is the surface a player judges a
             stranger by — handle, display name, bio — so it is the one worth being able
             to report even when they have posted nothing. -->
        {#if !mine && account}
          <ReportButton subject="account" onclick={() => (reporting = true)} />
        {/if}
      </div>
    {/if}
  </div>

  {#if !account && !loading}
    <EmptyState title="No such handle" description="Nobody here goes by @{handle}." />
  {:else}
    <div class="border-outline-variant border-b p-2">
      <SegmentedControl
        aria-label="Profile sections"
        selected={tab}
        onchange={(id) => (tab = id as 'blabs' | 'replies')}
        options={[
          { id: 'blabs', label: 'Blabs' },
          { id: 'replies', label: 'Replies' }
        ]}
      />
    </div>

    <div class="flex-1 overflow-y-auto" onscroll={onScroll}>
      {#if loading && rows.length === 0}
        <div class="p-4"><Skeleton count={3} height="h-16" /></div>
      {:else if rows.length === 0}
        <EmptyState
          title={tab === 'replies' ? 'No replies yet' : 'No Blabs yet'}
          description={tab === 'replies'
            ? 'Replies to other people will show up here.'
            : 'Posts will show up here.'}
        />
      {:else}
        {#each rows as blab (blab.id)}
          <BlabRow {blab} {onhandle} />
        {/each}
        {#if loading}
          <div class="p-4"><Skeleton count={1} height="h-16" /></div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

{#if reporting && account}
  <ReportDialog
    targetTable="gphone_accounts"
    targetId={account.id}
    appId="blabber"
    onclose={() => (reporting = false)}
  />
{/if}
