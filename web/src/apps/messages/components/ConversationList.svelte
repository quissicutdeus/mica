<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Avatar,
    ChevronRightIcon,
    EmptyState,
    ListItem,
    MessageStatusIcon,
    SearchBar,
    Skeleton,
    formatRelativeTime,
    useLocale,
    type UIConversation
  } from '@gphone/sdk';

  const { t } = useLocale();

  /** The inbox: every conversation, or the archive, with its search. */
  let {
    conversations,
    loaded,
    hasMore,
    loadingMore,
    query = $bindable(''),
    showSearch,
    viewingArchive,
    myCitizenId,
    isLastMsgReadByOther,
    onselect,
    onloadmore
  }: {
    conversations: UIConversation[];
    loaded: boolean;
    /**
     * The server said there are older threads behind this page.
     *
     * False for very nearly everyone — see the note on the control below — so this is an
     * affordance that appears only when it has something to do, rather than a permanent
     * fixture at the end of the inbox.
     */
    hasMore: boolean;
    loadingMore: boolean;
    query: string;
    showSearch: boolean;
    viewingArchive: boolean;
    myCitizenId: string;
    isLastMsgReadByOther: (conv: UIConversation) => boolean;
    onselect: (id: number) => void;
    onloadmore: () => void;
  } = $props();
</script>

{#if showSearch}
  <!-- Search Dropdown Overlay -->
  <div
    class="animate-in slide-in-from-top border-outline-variant bg-surface duration-medium ease-emphasized sticky top-0 z-20 border-b p-3 backdrop-blur-md"
  >
    <SearchBar bind:value={query} placeholder={$t('messages.searchChats')} focus={true} />
  </div>
{/if}

<!-- Conversation List -->
<div class="divide-outline-variant divide-y">
  {#each conversations as conv (conv.id)}
    <ListItem class="hover:bg-surface-container items-start" onclick={() => onselect(conv.id)}>
      <div class="relative mr-4 shrink-0">
        <Avatar
          src={conv.targetAvatar}
          initials={conv.targetName ? conv.targetName[0] : conv.target[0] || '?'}
          size="w-12 h-12"
          textClass="text-lg"
          bgClass={conv.is_group
            ? 'bg-indigo-700'
            : 'bg-surface-container border border-outline-variant'}
        />
        {#if conv.unreadCount > 0}
          <div
            class="border-surface bg-primary text-on-primary shadow-elevation-2 text-label-small absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full border-2 px-1"
          >
            {conv.unreadCount}
          </div>
        {/if}
      </div>

      <div class="min-w-0 flex-1">
        <div class="mb-1 flex items-baseline justify-between">
          <span
            class="text-body-medium truncate font-semibold {conv.unreadCount > 0
              ? 'text-on-surface font-bold'
              : 'text-on-surface'}"
          >
            {conv.targetName || conv.target}
          </span>
          <span
            class="text-body-small {conv.unreadCount > 0
              ? 'text-primary '
              : 'text-on-surface-variant'} ml-2 whitespace-nowrap"
          >
            {formatRelativeTime(conv.lastMessageAt)}
          </span>
        </div>
        <div class="flex items-center">
          {#if conv.last_message?.citizenid === myCitizenId}
            <MessageStatusIcon
              status={isLastMsgReadByOther(conv) ? 'read' : 'delivered'}
              class="mr-1.5 h-3.5 w-3.5 shrink-0"
            />
          {/if}
          <p
            class="text-body-medium flex-1 truncate {conv.unreadCount > 0
              ? 'text-on-surface '
              : 'text-on-surface-variant'}"
          >
            {conv.lastMessage || $t('messages.noMessages')}
          </p>
          <ChevronRightIcon
            class="text-outline duration-short ease-standard size-icon-sm ml-2 opacity-0 transition-opacity group-hover:opacity-100"
          />
        </div>
      </div>
    </ListItem>
  {/each}

  {#if !loaded}
    <div class="p-3">
      <Skeleton count={5} height="h-16" />
    </div>
  {:else if conversations.length === 0}
    <div class="py-16 text-center">
      <EmptyState
        title={query.trim()
          ? $t('messages.noMatchingMessages')
          : viewingArchive
            ? $t('messages.noArchived')
            : $t('messages.noActive')}
      />
    </div>
  {/if}

  <!--
    Older threads, a server page at a time.

    A page is a screenful — 25, `CONVERSATION_PAGE_SIZE` in `services/conversations.ts`,
    matched to the server's own `paging.pageSize` — so this is an ordinary control that an
    ordinary player with more than a screen of threads will see and use (MICA-211).

    It used to be the opposite: the page was 200, above any real list, and this button
    existed only for the player past that line whose remaining threads were otherwise
    unreachable. The page had to be that large because `findForCitizen` walked the keyset on
    `c.id DESC` while this list is ordered by recency of the last message, and those are
    different orders — an old thread someone still texts daily has a low id and a recent
    `lastMessageAt`, so a smaller page dropped it out of the top of the inbox until enough
    pages had loaded to reach it. The server pages on that recency now, so the first page is
    the newest threads and a later page is always older. The store's own note has the rest.

    Outside the block above rather than a fourth arm of it, because a filtered view can show
    nothing and still have pages behind it: the archive tab and the search box both narrow
    what has already been fetched, so hiding this whenever the visible list is empty would
    strand the rest of the inbox behind an empty state.

    `pb-home-indicator` because this is the last thing in the scroller, and `PhoneFrame`
    paints its gesture bar over the bottom of the screen — without the shared inset the
    button's lower third is inside a control that goes home.
  -->
  {#if loaded && hasMore}
    <div class="pb-home-indicator flex justify-center py-4">
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
          <span>{$t('messages.loadingOlderConversations')}</span>
        {:else}
          <span>{$t('messages.loadOlderConversations')}</span>
        {/if}
      </button>
    </div>
  {/if}
</div>
