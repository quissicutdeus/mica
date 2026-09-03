<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { EmptyState, useLocale, type UIConversation, type UIMessage } from '@gos/sdk';

  const { t } = useLocale();
  import type { ReactionSummary } from '@gos/shared/types';
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
    hasOlder,
    loadingMore,
    unreadDividerIndex,
    currentConv,
    lastReadMyMessageId,
    isReadByOther,
    unreadCount,
    searching,
    onreply,
    onscrollto,
    onedit,
    ondelete,
    onloadmore,
    onscroll,
    reactions,
    ontogglereaction
  }: {
    messages: UIMessage[];
    offset: number;
    hiddenCount: number;
    /** Whether the server holds an older page behind the loaded thread (MICA-212). */
    hasOlder: boolean;
    loadingMore: boolean;
    unreadDividerIndex: number;
    currentConv: UIConversation | null | undefined;
    lastReadMyMessageId: number | null;
    /** How many were unread on open, for the divider's label. */
    unreadCount: number;
    /** Whether the in-chat search is filtering, so "empty" reads correctly. */
    searching: boolean;
    isReadByOther: (msg: UIMessage) => boolean;
    onreply?: (msg: UIMessage) => void;
    onscrollto?: (msgId: number) => void;
    /** Rewrite one of your own messages — handled by the app, in the composer. */
    onedit?: (msg: UIMessage) => void;
    /** Unsend one of your own messages, for everyone. */
    ondelete?: (msg: UIMessage) => Promise<void> | void;
    onloadmore: () => void;
    onscroll: (event: Event) => void;
    /** Reaction summaries keyed by message id — `$messageReactions` handed straight through. */
    reactions: Record<number, ReactionSummary>;
    ontogglereaction: (messageId: number, emoji: string) => void;
  } = $props();
</script>

<!-- Messages List -->
<div id="messages-container" class="no-scrollbar flex-1 space-y-4 overflow-y-auto p-4" {onscroll}>
  <!--
    The control shows while there is anything older to reveal: rows the window is hiding
    locally, or a page the server has not been asked for yet. The label counts only what is
    hidden locally — a number the phone knows; how long the thread is server-side, it does not.
  -->
  {#if hiddenCount > 0 || hasOlder}
    <div class="my-2 flex justify-center">
      <button
        type="button"
        class="border-primary bg-surface-container text-primary hover:bg-surface-container shadow-elevation-1 duration-short ease-standard text-body-small flex cursor-pointer items-center gap-2 rounded-box border px-3.5 py-1.5 transition-colors"
        onclick={onloadmore}
      >
        {#if loadingMore}
          <span class="relative flex h-2 w-2">
            <span
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75"
            ></span>
            <span class="bg-primary relative inline-flex h-2 w-2 rounded-full"></span>
          </span>
          <span>{$t('messages.loadingOlderMessages')}</span>
        {:else if hiddenCount > 0}
          <span>{$t('messages.loadOlderMessages', { count: hiddenCount })}</span>
        {:else}
          <span>{$t('messages.loadOlderMessagesPage')}</span>
        {/if}
      </button>
    </div>
  {/if}

  {#each messages as msg, index (msg.id)}
    {#if unreadDividerIndex >= 0 && index + offset === unreadDividerIndex}
      <div id="unread-divider" class="my-4 flex items-center gap-3 py-1">
        <div class="bg-primary h-px flex-1"></div>
        <span
          class="border-primary text-primary shadow-elevation-2 text-label-small rounded-box border bg-blue-950/90 px-3 py-1 tracking-wider uppercase"
        >
          {$t('messages.unreadMessages', { count: unreadCount })}
        </span>
        <div class="bg-primary h-px flex-1"></div>
      </div>
    {/if}
    {#if currentConv}
      <MessageBubble
        {msg}
        {currentConv}
        isLastReadMyMessage={msg.id === lastReadMyMessageId}
        isReadByOther={isReadByOther(msg)}
        {onreply}
        {onscrollto}
        {onedit}
        {ondelete}
        reactionSummary={reactions[msg.id]}
        ontogglereaction={(emoji: string) => ontogglereaction(msg.id, emoji)}
      />
    {/if}
  {/each}
  {#if messages.length === 0}
    <div class="mt-10">
      <EmptyState
        title={searching ? $t('messages.noMatchingInChat') : $t('messages.noMessagesYet')}
      />
    </div>
  {/if}
</div>
