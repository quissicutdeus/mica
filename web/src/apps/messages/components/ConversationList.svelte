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
    type UIConversation
  } from '@gphone/sdk';

  /** The inbox: every conversation, or the archive, with its search. */
  let {
    conversations,
    loaded,
    query = $bindable(''),
    showSearch,
    viewingArchive,
    myCitizenId,
    isLastMsgReadByOther,
    onselect
  }: {
    conversations: UIConversation[];
    loaded: boolean;
    query: string;
    showSearch: boolean;
    viewingArchive: boolean;
    myCitizenId: string;
    isLastMsgReadByOther: (conv: UIConversation) => boolean;
    onselect: (id: number) => void;
  } = $props();
</script>

{#if showSearch}
  <!-- Search Dropdown Overlay -->
  <div
    class="animate-in slide-in-from-top border-outline-variant bg-surface sticky top-0 z-20 border-b p-3 backdrop-blur-md duration-200"
  >
    <SearchBar bind:value={query} placeholder="Search chats, names, or messages..." focus={true} />
  </div>
{/if}

<!-- Conversation List -->
<div class="divide-outline-variant divide-y">
  {#each conversations as conv}
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
            class="border-surface bg-primary shadow-elevation-2 absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full border-2 px-1 text-[10px] font-bold"
          >
            {conv.unreadCount}
          </div>
        {/if}
      </div>

      <div class="min-w-0 flex-1">
        <div class="mb-1 flex items-baseline justify-between">
          <span
            class="truncate text-[15px] font-semibold {conv.unreadCount > 0
              ? 'text-on-surface font-bold'
              : 'text-on-surface'}"
          >
            {conv.targetName || conv.target}
          </span>
          <span
            class="text-xs {conv.unreadCount > 0
              ? 'text-primary font-semibold'
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
            class="flex-1 truncate text-sm {conv.unreadCount > 0
              ? 'text-on-surface font-medium'
              : 'text-on-surface-variant'}"
          >
            {conv.lastMessage || 'No messages'}
          </p>
          <ChevronRightIcon
            class="text-outline ml-2 h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100"
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
          ? 'No matching messages found'
          : viewingArchive
            ? 'No archived conversations'
            : 'No active conversations'}
      />
    </div>
  {/if}
</div>
