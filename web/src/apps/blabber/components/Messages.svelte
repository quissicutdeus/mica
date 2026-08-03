<script lang="ts">
  import { Avatar, EmptyState, Skeleton, formatDate, useBlabber } from '@gphone/sdk';
  import Composer from './Composer.svelte';
  import BlabBody from './BlabBody.svelte';

  /**
   * The DM inbox, and one thread.
   *
   * Strictly 1:1, so a thread is identified by the **peer account** rather than by a conversation
   * row — there is nothing to create before the first message, and nothing a third person could
   * be added to. That is the whole reason DMs here are not Conversations, which needs a
   * participants table precisely because its threads can grow.
   */
  let {
    handle,
    busy = false,
    peer = null,
    onopen,
    onhandle
  }: {
    handle?: string;
    busy?: boolean;
    peer?: number | null;
    onopen?: (peerAccountId: number | null) => void;
    onhandle?: (handle: string) => void;
  } = $props();

  const { dmThreads, dmMessages, loadDmThreads, loadDmMessages, sendDm } = useBlabber();

  let loading = $state(true);

  $effect(() => {
    loading = true;
    const task = peer === null ? loadDmThreads() : loadDmMessages(peer);
    void task.finally(() => (loading = false));
  });

  const active = $derived($dmThreads.find((thread) => thread.peer_account_id === peer));
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
          class="flex w-full items-center gap-3 border-b border-gray-800 px-4 py-3 text-left"
          onclick={() => onopen?.(thread.peer_account_id)}
        >
          <Avatar
            initials={(thread.handle ?? '?').slice(0, 2).toUpperCase()}
            size="w-9 h-9"
            showSilhouette={false}
          />
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 text-xs">
              <span class="truncate font-semibold text-white"
                >{thread.display_name || thread.handle}</span
              >
              <span class="truncate text-gray-500">@{thread.handle}</span>
            </p>
            <p class="truncate text-xs text-gray-400">{thread.last?.body ?? ''}</p>
          </div>
          {#if thread.unread > 0}
            <span
              class="shrink-0 rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-bold text-white"
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
    <div class="flex items-center gap-2 border-b border-gray-800 px-4 py-2.5">
      <Avatar
        initials={(active?.handle ?? '?').slice(0, 2).toUpperCase()}
        size="w-8 h-8"
        showSilhouette={false}
      />
      <button
        type="button"
        class="truncate text-sm font-semibold text-white hover:underline"
        onclick={() => active?.handle && onhandle?.(active.handle)}
      >
        @{active?.handle ?? ''}
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
              class:bg-sky-600={mine}
              class:bg-gray-800={!mine}
            >
              <BlabBody body={message.body} {onhandle} />
              <p class="mt-0.5 text-[10px] text-gray-400">{formatDate(message.created_at)}</p>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <Composer {handle} placeholder="Message" {busy} onsubmit={(body) => sendDm(peer, body)} />
  </div>
{/if}
