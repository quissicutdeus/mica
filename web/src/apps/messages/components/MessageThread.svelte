<script lang="ts">
  import { EmptyState, type UIConversation, type UIMessage } from '@gphone/sdk';
  import MessageBubble from './MessageBubble.svelte';

  /**
   * The scrolling thread: older-messages control, unread divider, bubbles.
   *
   * `offset` is the window's start index in the full thread. The divider is positioned
   * against the whole conversation, so comparing a loop index to it without the offset
   * puts the "unread" line on the wrong message the moment a page is revealed.
   */
  let {
    messages,
    offset,
    hiddenCount,
    loadingMore,
    unreadDividerIndex,
    currentConv,
    lastReadMyMessageId,
    isReadByOther,
    unreadCount,
    searching,
    onloadmore,
    onscroll
  }: {
    messages: UIMessage[];
    offset: number;
    hiddenCount: number;
    loadingMore: boolean;
    unreadDividerIndex: number;
    currentConv: UIConversation | null | undefined;
    lastReadMyMessageId: number | null;
    /** How many were unread on open, for the divider's label. */
    unreadCount: number;
    /** Whether the in-chat search is filtering, so "empty" reads correctly. */
    searching: boolean;
    isReadByOther: (msg: UIMessage) => boolean;
    onloadmore: () => void;
    onscroll: (event: Event) => void;
  } = $props();
</script>

<!-- Messages List -->
<div id="messages-container" class="no-scrollbar flex-1 space-y-4 overflow-y-auto p-4" {onscroll}>
  {#if hiddenCount > 0}
    <div class="my-2 flex justify-center">
      <button
        type="button"
        class="flex cursor-pointer items-center gap-2 rounded-full border border-blue-500/20 bg-gray-800/80 px-3.5 py-1.5 text-xs font-medium text-blue-400 shadow-sm transition-colors hover:bg-gray-800"
        onclick={onloadmore}
      >
        {#if loadingMore}
          <span class="relative flex h-2 w-2">
            <span
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75"
            ></span>
            <span class="relative inline-flex h-2 w-2 rounded-full bg-blue-500"></span>
          </span>
          <span>Loading older messages...</span>
        {:else}
          <span>Load older messages ({hiddenCount} hidden)</span>
        {/if}
      </button>
    </div>
  {/if}

  {#each messages as msg, index (msg.id)}
    {#if unreadDividerIndex >= 0 && index + offset === unreadDividerIndex}
      <div id="unread-divider" class="my-4 flex items-center gap-3 py-1">
        <div class="h-px flex-1 bg-blue-500/40"></div>
        <span
          class="rounded-full border border-blue-500/30 bg-blue-950/90 px-3 py-1 text-[10px] font-bold tracking-wider text-blue-400 uppercase shadow-md"
        >
          Unread Messages ({unreadCount})
        </span>
        <div class="h-px flex-1 bg-blue-500/40"></div>
      </div>
    {/if}
    {#if currentConv}
      <MessageBubble
        {msg}
        {currentConv}
        isLastReadMyMessage={msg.id === lastReadMyMessageId}
        isReadByOther={isReadByOther(msg)}
      />
    {/if}
  {/each}
  {#if messages.length === 0}
    <div class="mt-10">
      <EmptyState
        title={searching ? 'No matching messages found in this chat' : 'No messages yet'}
      />
    </div>
  {/if}
</div>
