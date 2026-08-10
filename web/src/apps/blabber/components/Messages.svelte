<script lang="ts">
  import {
    Avatar,
    EmptyState,
    ReportButton,
    ReportDialog,
    Skeleton,
    formatDate
  } from '@gphone/sdk';
  import { useBlabber } from '../store';
  import type { Account } from '@shared/types';
  import DmComposer from './DmComposer.svelte';
  import BlabBody from './BlabBody.svelte';

  /**
   * The little the header needs about a correspondent.
   *
   * Not the whole `Account`: the inbox row carries a handle and a display name and no more, and
   * a type demanding an avatar would force one of the two call sites to invent a field.
   */
  type DmPeer = Pick<Account, 'handle' | 'display_name'> & { avatar?: string | null };

  /**
   * The DM inbox, and one thread.
   *
   * Strictly 1:1, so a thread is identified by the **peer account** rather than by a conversation
   * row — there is nothing to create before the first message, and nothing a third person could
   * be added to. That is the whole reason DMs here are not Conversations, which needs a
   * participants table precisely because its threads can grow.
   *
   * `peerAccount` is who the thread is with when the inbox has no row for them yet — a
   * conversation started from a profile, before either side has sent anything. Without it the
   * header resolved the peer out of `$dmThreads` alone and rendered `@` with a `?` avatar under
   * the literal title "Message".
   */
  let {
    busy = false,
    peer = null,
    peerAccount = null,
    onopen,
    onpeername,
    onhandle,
    ontag
  }: {
    busy?: boolean;
    peer?: number | null;
    peerAccount?: DmPeer | null;
    onopen?: (peerAccountId: number | null, account?: DmPeer | null) => void;
    /** Reports the peer's name upward, so the screen title can be it rather than "Message". */
    onpeername?: (name: string | null) => void;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
  } = $props();

  const { dmThreads, dmMessages, loadDmThreads, loadDmMessages, sendDm } = useBlabber();

  let loading = $state(true);

  $effect(() => {
    loading = true;
    const task = peer === null ? loadDmThreads() : loadDmMessages(peer);
    void task.finally(() => (loading = false));
  });

  const thread = $derived($dmThreads.find((row) => row.peer_account_id === peer));
  /** The inbox's row wins once it exists; the handed-down account covers the first message. */
  const active = $derived(
    thread ?? (peerAccount ? { ...peerAccount, peer_account_id: peer } : undefined)
  );

  $effect(() => {
    onpeername?.(active ? active.display_name || `@${active.handle}` : null);
  });

  /** Which DM is being reported, by id. Null when the dialog is closed. */
  let reportingDm = $state<number | null>(null);
</script>

{#if peer === null}
  <div class="flex-1 overflow-y-auto">
    {#if loading && $dmThreads.length === 0}
      <div class="p-4"><Skeleton count={3} height="h-16" /></div>
    {:else if $dmThreads.length === 0}
      <EmptyState title="No messages" description="Tap a handle to start a conversation." />
    {:else}
      {#each $dmThreads as thread (thread.peer_account_id)}
        <button
          type="button"
          class="border-outline-variant flex w-full items-center gap-3 border-b px-4 py-3 text-left"
          onclick={() =>
            onopen?.(thread.peer_account_id, {
              handle: thread.handle ?? '',
              display_name: thread.display_name
            })}
        >
          <Avatar
            initials={(thread.handle ?? '?').slice(0, 2).toUpperCase()}
            size="w-9 h-9"
            showSilhouette={false}
          />
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 text-xs">
              <span class="text-on-surface truncate font-semibold"
                >{thread.display_name || thread.handle}</span
              >
              <span class="text-on-surface-variant truncate">@{thread.handle}</span>
            </p>
            <p class="text-on-surface-variant truncate text-xs">{thread.last?.body ?? ''}</p>
          </div>
          {#if thread.unread > 0}
            <span
              class="bg-primary-container text-on-primary-container shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold"
            >
              {thread.unread}
            </span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
{:else}
  <div class="flex h-full flex-col">
    <div class="border-outline-variant flex items-center gap-2 border-b px-4 py-2.5">
      <Avatar
        initials={(active?.handle || '?').slice(0, 2).toUpperCase()}
        src={peerAccount?.avatar ?? ''}
        size="w-8 h-8"
        showSilhouette={false}
      />
      <button
        type="button"
        class="min-w-0 text-left hover:underline"
        onclick={() => active?.handle && onhandle?.(active.handle)}
      >
        <span class="text-on-surface block truncate text-sm font-semibold">
          {active?.display_name || (active?.handle ? `@${active.handle}` : 'Message')}
        </span>
        {#if active?.display_name && active.handle}
          <span class="text-on-surface-variant block truncate text-xs">@{active.handle}</span>
        {/if}
      </button>
    </div>

    <!-- Newest first, so the list needs no scroll-to-bottom and the composer sits above it. -->
    <div class="flex-1 overflow-y-auto">
      {#if loading && $dmMessages.length === 0}
        <div class="p-4"><Skeleton count={3} height="h-12" /></div>
      {:else if $dmMessages.length === 0}
        <EmptyState title="Nothing yet" description="Say hello." />
      {:else}
        {#each $dmMessages as message (message.id)}
          {@const mine = message.to_account === peer}
          <div class="flex px-4 py-1.5" class:justify-end={mine}>
            <div
              class="max-w-[80%] rounded-2xl px-3 py-2"
              class:bg-primary={mine}
              class:bg-surface-container={!mine}
            >
              <BlabBody body={message.body} {onhandle} {ontag} />
              <div class="mt-0.5 flex items-center gap-1">
                <p class="text-on-surface-variant text-[10px]">
                  {formatDate(message.created_at)}
                </p>
                <!-- Theirs only. Reporting your own message is not moderation, and the
                     server refuses it — an affordance that always fails is worse than
                     none. A DM is also the surface where reporting matters most, since
                     it is the one a stranger can reach you on. -->
                {#if !mine}
                  <ReportButton
                    subject="message"
                    onclick={() => (reportingDm = message.id)}
                    class="-my-1"
                  />
                {/if}
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <DmComposer {busy} onsubmit={(body) => sendDm(peer, body)} />
  </div>
{/if}

{#if reportingDm !== null}
  <ReportDialog
    targetTable="gphone_blabber_dms"
    targetId={reportingDm}
    onclose={() => (reportingDm = null)}
  />
{/if}
