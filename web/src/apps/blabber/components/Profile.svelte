<script lang="ts">
  import {
    Avatar,
    EmptyState,
    MessageIcon,
    SegmentedControl,
    Skeleton,
    useBlabber,
    useNuiBridge
  } from '@gphone/sdk';
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
    onmessage
  }: {
    handle: string;
    onhandle?: (handle: string) => void;
    onmessage?: (account: Account) => void;
  } = $props();

  const { myAccounts } = useBlabber();
  const { fetchNui } = useNuiBridge();

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
    const reply = await fetchNui<{ rows: Account[] }>(
      'getAccounts',
      { app: 'blabber', handle, limit: 1 },
      { defaultValue: { rows: [] } }
    );
    account = reply.rows?.[0] ?? null;
  };

  const loadPage = async (from: number | null) => {
    if (!account) return;
    loading = true;
    try {
      const reply = await fetchNui<{ rows: Blab[]; nextCursor: number | null }>(
        'getProfileBlabs',
        { account_id: account.id, tab, cursor: from ?? undefined },
        { defaultValue: { rows: [], nextCursor: null } }
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
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-3 border-b border-gray-800 p-4">
    <Avatar
      src={account?.avatar ?? undefined}
      initials={handle.slice(0, 2).toUpperCase()}
      size="w-14 h-14"
      showSilhouette={false}
    />
    <div class="min-w-0">
      <p class="truncate text-base font-bold text-white">
        {account?.display_name || handle}
      </p>
      <p class="truncate text-xs text-gray-500">@{handle}{mine ? ' · you' : ''}</p>
      {#if account?.bio}
        <p class="mt-1 text-xs text-gray-300">{account.bio}</p>
      {/if}
    </div>
    <!-- Not on your own profile: a DM to yourself is a thread with one participant, which the
         1:1 shape has no room for. -->
    {#if account && !mine && onmessage}
      <button
        type="button"
        class="ml-auto shrink-0 rounded-full bg-sky-600 p-2 text-white transition-colors hover:bg-sky-500"
        onclick={() => account && onmessage(account)}
        title="Message @{handle}"
        aria-label="Message @{handle}"
      >
        <MessageIcon class="h-4 w-4" />
      </button>
    {/if}
  </div>

  {#if !account && !loading}
    <EmptyState title="No such handle" description="Nobody here goes by @{handle}." />
  {:else}
    <div class="border-b border-gray-800 p-2">
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
