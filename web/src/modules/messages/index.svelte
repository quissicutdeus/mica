<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Screen from '../../components/Screen.svelte';
  import {
    useMessages,
    useContacts,
    useCamera,
    useAccount,
    useNavigation,
    type UIMessage,
    type UIConversation
  } from '@gphone/sdk';
  import { fade, fly } from 'svelte/transition';
  import type { Contact, Photo } from '@shared/types';

  const { messagesStore } = useMessages();
  const { consumeDeepLink } = useNavigation();
  const { contactsStore: contacts } = useContacts();
  const { photosStore: photos } = useCamera();
  const { citizenid } = useAccount();
  import { formatTime, formatRelativeTime } from '../../utils/formatters';
  import { useScrollDetect } from '../../utils/useScrollDetect';
  import PaperclipIcon from '../../components/icons/PaperclipIcon.svelte';
  import CloseIcon from '../../components/icons/CloseIcon.svelte';
  import SendIcon from '../../components/icons/SendIcon.svelte';
  import PhotoIcon from '../../components/icons/PhotoIcon.svelte';
  import LocationIcon from '../../components/icons/LocationIcon.svelte';
  import ChevronRightIcon from '../../components/icons/ChevronRightIcon.svelte';
  import MessageIcon from '../../components/icons/MessageIcon.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import SearchBar from '../../components/SearchBar.svelte';
  import ListItem from '../../components/ListItem.svelte';
  import Avatar from '../../components/Avatar.svelte';
  import Button from '../../components/Button.svelte';
  import TrashIcon from '../../components/icons/TrashIcon.svelte';
  import ArchiveIcon from '../../components/icons/ArchiveIcon.svelte';
  import SearchIcon from '../../components/icons/SearchIcon.svelte';
  import MessageStatusIcon from '../../components/icons/MessageStatusIcon.svelte';
  import MessageBubble from './components/MessageBubble.svelte';
  import ConversationDetailsModal from './components/ConversationDetailsModal.svelte';
  import PhotoPickerModal from '../../components/PhotoPickerModal.svelte';
  import FloatingActionButton from '../../components/FloatingActionButton.svelte';

  let { onback, initialContact, conversationId, phone } = $props<{
    onback?: () => void;
    initialContact?: Contact;
    conversationId?: number;
    phone?: string;
  }>();

  // Local state for UI
  let selectedConversationId: number | null = $state(null);
  let isComposing = $state(false);
  let newMessageText = $state('');
  let recipientQuery = $state(''); // For searching contacts when composing
  let showAttachMenu = $state(false);
  let showPhotoPicker = $state(false);
  let selectedAttachments = $state<{ photo_id: number; image: string }[]>([]);
  let viewingArchive = $state(false);
  let showDetailsModal = $state(false);
  let showSearch = $state(false);
  let searchQuery = $state('');
  let initialUnreadCount = $state(0);
  let unreadDividerIndex = $state(-1);
  let isScrolled = $state(false);
  let showInChatSearch = $state(false);
  let inChatSearchQuery = $state('');

  // Derived values
  let conversations = $derived($messagesStore);

  // Store already sorts newest-first on load/send, no need to re-sort here
  let activeConversations = $derived(
    conversations.filter((c) => (c.status || 'active') === 'active')
  );
  let archivedConversations = $derived(conversations.filter((c) => c.status === 'archived'));
  let displayedConversations = $derived(
    viewingArchive ? archivedConversations : activeConversations
  );
  let filteredConversations = $derived(
    searchQuery.trim()
      ? displayedConversations.filter(
          (c) =>
            (c.targetName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
            (c.target || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
            (c.lastMessage || '').toLowerCase().includes(searchQuery.toLowerCase())
        )
      : displayedConversations
  );
  let currentConv = $derived(
    selectedConversationId ? conversations.find((c) => c.id === selectedConversationId) : null
  );

  // Derived messages for current conversation
  // We must subscribe to the inner store
  const messageStore = messagesStore.messages;
  let messages = $derived(
    selectedConversationId ? $messageStore[selectedConversationId] || [] : []
  );
  let filteredMessages = $derived(
    inChatSearchQuery.trim()
      ? messages.filter((m) =>
          (m.message || '').toLowerCase().includes(inChatSearchQuery.toLowerCase())
        )
      : messages
  );

  const MESSAGE_PAGE_SIZE = 50;
  let displayLimit = $state(MESSAGE_PAGE_SIZE);

  let renderedMessages = $derived.by(() => {
    if (inChatSearchQuery.trim() || filteredMessages.length <= displayLimit) {
      return filteredMessages;
    }
    return filteredMessages.slice(filteredMessages.length - displayLimit);
  });

  let hiddenMessageCount = $derived(
    !inChatSearchQuery.trim() && filteredMessages.length > displayLimit
      ? filteredMessages.length - displayLimit
      : 0
  );

  let renderIndexOffset = $derived(filteredMessages.length - renderedMessages.length);

  let isLoadingMoreMessages = $state(false);
  const loadMoreOlderMessages = async () => {
    if (hiddenMessageCount <= 0 || isLoadingMoreMessages) return;
    isLoadingMoreMessages = true;

    const container = document.getElementById('messages-container');
    const prevScrollHeight = container ? container.scrollHeight : 0;
    const prevScrollTop = container ? container.scrollTop : 0;

    displayLimit += MESSAGE_PAGE_SIZE;

    await tick();

    if (container) {
      container.scrollTop = container.scrollHeight - prevScrollHeight + prevScrollTop;
    }

    isLoadingMoreMessages = false;
  };

  const handleMessagesScroll = (e: Event) => {
    const target = e.target as HTMLElement;
    if (!target) return;
    if (target.scrollTop <= 40 && hiddenMessageCount > 0) {
      loadMoreOlderMessages();
    }
  };

  const isMessageReadByOther = (msg: UIMessage) => {
    if (!currentConv || !currentConv.participants || currentConv.participants.length === 0)
      return false;
    const other = currentConv.participants.find((p) => p.citizenid !== $citizenid);
    if (!other || !other.last_read) return false;
    return new Date(msg.created_at).getTime() <= new Date(other.last_read).getTime();
  };

  const isConvLastMsgReadByOther = (conv: UIConversation) => {
    if (!conv || !conv.participants || conv.participants.length === 0) return false;
    const other = conv.participants.find((p) => p.citizenid !== $citizenid);
    if (!other || !other.last_read || !conv.last_message) return false;
    return new Date(conv.last_message.created_at).getTime() <= new Date(other.last_read).getTime();
  };

  let lastReadMyMessageId = $derived.by(() => {
    if (!currentConv || !currentConv.participants || filteredMessages.length === 0) return null;
    const lastMsg = filteredMessages[filteredMessages.length - 1];
    if (lastMsg && lastMsg.sender === 'me' && isMessageReadByOther(lastMsg)) {
      return lastMsg.id;
    }
    return null;
  });

  // Filter contacts for composition
  let filteredContacts = $derived(
    recipientQuery
      ? $contacts.filter(
          (c) =>
            c.firstname.toLowerCase().includes(recipientQuery.toLowerCase()) ||
            (c.lastname || '').toLowerCase().includes(recipientQuery.toLowerCase()) ||
            c.phone.includes(recipientQuery)
        )
      : $contacts
  );

  const goBack = () => {
    if (showDetailsModal) {
      showDetailsModal = false;
    } else if (showInChatSearch) {
      showInChatSearch = false;
      inChatSearchQuery = '';
    } else if (selectedConversationId || isComposing) {
      selectedConversationId = null;
      messagesStore.setActiveConversationId(null);
      isComposing = false;
      newMessageText = '';
      recipientQuery = '';
      showAttachMenu = false;
      showPhotoPicker = false;
      selectedAttachments = [];
      showInChatSearch = false;
      inChatSearchQuery = '';
      unreadDividerIndex = -1;
      displayLimit = MESSAGE_PAGE_SIZE;
    } else if (showSearch) {
      showSearch = false;
      searchQuery = '';
    } else if (viewingArchive) {
      viewingArchive = false;
    } else {
      onback?.();
    }
  };

  const handleTitleClick = () => {
    if (selectedConversationId && currentConv) {
      showDetailsModal = true;
    }
  };

  const handleSelectConversation = async (id: number) => {
    displayLimit = MESSAGE_PAGE_SIZE;
    const conv = $messagesStore.find((c) => c.id === id);
    initialUnreadCount = conv?.unreadCount || 0;
    selectedConversationId = id;
    await messagesStore.loadMessages(id);

    const msgs = $messageStore[id] || [];
    if (initialUnreadCount > 0 && msgs.length > 0) {
      unreadDividerIndex = Math.max(0, msgs.length - initialUnreadCount);
    } else {
      unreadDividerIndex = -1;
    }

    await tick();

    if (initialUnreadCount > 0) {
      scrollToUnreadDivider();
      await messagesStore.markAsRead(id);
    } else {
      scrollToBottom();
    }
  };

  const scrollToUnreadDivider = () => {
    const unreadEl = document.getElementById('unread-divider');
    const container = document.getElementById('messages-container');
    if (unreadEl && container) {
      container.scrollTop = Math.max(0, unreadEl.offsetTop - 16);
    } else {
      scrollToBottom();
    }
  };

  const startNewMessage = () => {
    isComposing = true;
    recipientQuery = '';
  };

  const handleSelectContactRaw = async (contact: Contact) => {
    // Check if conversation already exists
    const existing = $messagesStore.find((c) => c.target === contact.phone);
    if (existing) {
      handleSelectConversation(existing.id);
      isComposing = false;
    } else {
      // Start new conversation via store
      try {
        const newConv = await messagesStore.startConversation(contact.phone);
        if (newConv) {
          selectedConversationId = newConv.id;
          isComposing = false;
        }
      } catch (e) {
        console.error('Failed to start conversation', e);
      }
    }
  };

  const openPhotoPicker = async () => {
    await photos.load();
    showPhotoPicker = true;
    showAttachMenu = false;
  };

  const handleSendMessage = async () => {
    if ((!newMessageText.trim() && selectedAttachments.length === 0) || !selectedConversationId)
      return;

    try {
      await messagesStore.sendMessage(
        selectedConversationId,
        newMessageText,
        selectedAttachments.map((att) => ({
          photo_id: att.photo_id,
          attachment: att.image
        }))
      );
      newMessageText = '';
      selectedAttachments = [];
      await tick();
      scrollToBottom();
    } catch (e) {
      console.error('Failed to send message', e);
    }
  };

  const scrollToBottom = () => {
    const el = document.getElementById('messages-container');
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Load conversations on mount; deep-link navigation is handled by the $effect below
  onMount(() => {
    messagesStore.loadConversations();
  });

  /**
   * Act on a deep link exactly once.
   *
   * Consuming the props matters here for the same reason it does in Photos and Mail:
   * apps stay resident, so an unconsumed `conversationId` re-selects the thread every
   * time the user backs out to the conversation list.
   */
  $effect(() => {
    if (conversationId && conversationId !== selectedConversationId) {
      handleSelectConversation(conversationId);
      consumeDeepLink('messages');
    } else if (phone && (!currentConv || currentConv.target !== phone)) {
      const existing = $messagesStore.find((c) => c.target === phone);
      if (existing) {
        handleSelectConversation(existing.id);
        consumeDeepLink('messages');
      }
    } else if (initialContact && !selectedConversationId && !isComposing) {
      handleSelectContactRaw(initialContact);
      consumeDeepLink('messages');
    }
  });

  useScrollDetect((v) => (isScrolled = v));

  const getTitle = () => {
    if (isComposing) return 'New Message';
    if (currentConv) return currentConv.targetName || currentConv.target;
    if (selectedConversationId) return 'Chat';
    return viewingArchive ? 'Archived Messages' : 'Messages';
  };

  const focus = (el: HTMLInputElement) => el.focus();
</script>

{#snippet headerActions()}
  {#if !selectedConversationId && !isComposing}
    <div class="ml-auto flex items-center gap-1">
      <button
        class="rounded-full p-2 transition-colors hover:bg-gray-700 {viewingArchive
          ? 'bg-gray-800 text-blue-400'
          : 'text-gray-300'}"
        onclick={() => (viewingArchive = !viewingArchive)}
        title={viewingArchive ? 'View Inbox' : 'View Archive'}
        aria-label="Toggle Archive"
      >
        <ArchiveIcon class="h-5 w-5" />
      </button>
      <button
        class="rounded-full p-2 transition-colors hover:bg-gray-700 {showSearch
          ? 'bg-gray-800 text-blue-400'
          : 'text-gray-300'}"
        onclick={() => {
          showSearch = !showSearch;
          if (!showSearch) searchQuery = '';
        }}
        title="Search Messages"
        aria-label="Search Messages"
      >
        <SearchIcon class="h-5 w-5" />
      </button>
    </div>
  {:else if selectedConversationId && currentConv}
    <div class="ml-auto flex items-center gap-1">
      <button
        class="cursor-pointer rounded-full p-1.5 text-gray-300 transition-colors hover:bg-gray-700/60 hover:text-red-400"
        onclick={async () => {
          if (currentConv) {
            await messagesStore.deleteConversation(currentConv.id);
            selectedConversationId = null;
          }
        }}
        title="Delete Conversation"
        aria-label="Delete Conversation"
      >
        <TrashIcon class="h-5 w-5" />
      </button>
      <button
        class="cursor-pointer rounded-full p-1.5 text-gray-300 transition-colors hover:bg-gray-700/60 hover:text-blue-400"
        onclick={async () => {
          if (currentConv) {
            const isArchived = currentConv.status === 'archived';
            await messagesStore.archiveConversation(currentConv.id, !isArchived);
            selectedConversationId = null;
          }
        }}
        title={currentConv.status === 'archived' ? 'Unarchive' : 'Archive'}
        aria-label="Archive Conversation"
      >
        <ArchiveIcon class="h-5 w-5" />
      </button>
      <button
        class="cursor-pointer rounded-full p-1.5 transition-colors hover:bg-gray-700/60 {showInChatSearch
          ? 'bg-gray-800 text-blue-400'
          : 'text-gray-300 hover:text-white'}"
        onclick={() => {
          showInChatSearch = !showInChatSearch;
          if (!showInChatSearch) inChatSearchQuery = '';
        }}
        title="Search Messages"
        aria-label="Search Messages"
      >
        <SearchIcon class="h-5 w-5" />
      </button>
    </div>
  {/if}
{/snippet}

{#snippet fabOverlay()}
  {#if !selectedConversationId && !isComposing}
    <FloatingActionButton label="Start Chat" collapsed={isScrolled} onclick={startNewMessage}>
      {#snippet icon()}
        <MessageIcon class="h-4 w-4 shrink-0 text-white" />
      {/snippet}
    </FloatingActionButton>
  {/if}
{/snippet}

<Screen
  title={getTitle()}
  onback={goBack}
  ontitleclick={selectedConversationId ? handleTitleClick : undefined}
  actions={headerActions}
  overlay={fabOverlay}
>
  {#if !selectedConversationId}
    {#if isComposing}
      <!-- New Message Composition Panel (Sticky overlay directly below header) -->
      <div
        class="animate-in slide-in-from-top sticky top-0 z-20 space-y-3 border-b border-gray-800 bg-gray-900/95 p-4 shadow-2xl backdrop-blur-md duration-200"
      >
        <div class="flex items-center justify-between border-b border-gray-800 pb-1">
          <h3 class="text-base font-semibold text-white">New Conversation</h3>
          <button
            type="button"
            class="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
            onclick={() => (isComposing = false)}
            aria-label="Close form"
          >
            <CloseIcon class="h-5 w-5" />
          </button>
        </div>

        <SearchBar bind:value={recipientQuery} placeholder="To: Name or Phone Number" />

        <div
          class="max-h-56 divide-y divide-gray-800/60 overflow-y-auto rounded-xl bg-gray-800/40 p-1"
        >
          {#each filteredContacts as contact}
            <ListItem
              class="rounded-lg py-2 hover:bg-gray-800/80"
              onclick={() => handleSelectContactRaw(contact)}
            >
              <div class="mr-3 shrink-0">
                <Avatar src={contact.avatar} initials={contact.firstname[0]} size="w-9 h-9" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium text-white">
                  {contact.firstname}
                  {contact.lastname || ''}
                </div>
                <div class="text-xs text-gray-400">
                  {contact.phone}
                </div>
              </div>
            </ListItem>
          {/each}
          {#if filteredContacts.length === 0}
            <div class="py-6 text-center text-xs text-gray-400">No matching contacts found.</div>
          {/if}
        </div>

        <Button variant="secondary" class="w-full text-xs" onclick={() => (isComposing = false)}>
          Cancel
        </Button>
      </div>
    {/if}
  {/if}

  {#if selectedConversationId}
    <!-- Chat View -->
    <div class="flex h-full flex-col bg-gray-900">
      {#if showInChatSearch}
        <!-- In-Chat Search Bar -->
        <div
          class="animate-in slide-in-from-top sticky top-0 z-20 border-b border-gray-800 bg-gray-900/95 p-3 backdrop-blur-md duration-200"
        >
          <SearchBar bind:value={inChatSearchQuery} placeholder="Search messages in this chat..." />
        </div>
      {/if}

      <!-- Messages List -->
      <div
        id="messages-container"
        class="no-scrollbar flex-1 space-y-4 overflow-y-auto p-4"
        onscroll={handleMessagesScroll}
      >
        {#if hiddenMessageCount > 0}
          <div class="my-2 flex justify-center">
            <button
              type="button"
              class="flex cursor-pointer items-center gap-2 rounded-full border border-blue-500/20 bg-gray-800/80 px-3.5 py-1.5 text-xs font-medium text-blue-400 shadow-sm transition-colors hover:bg-gray-800"
              onclick={loadMoreOlderMessages}
            >
              {#if isLoadingMoreMessages}
                <span class="relative flex h-2 w-2">
                  <span
                    class="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75"
                  ></span>
                  <span class="relative inline-flex h-2 w-2 rounded-full bg-blue-500"></span>
                </span>
                <span>Loading older messages...</span>
              {:else}
                <span>Load older messages ({hiddenMessageCount} hidden)</span>
              {/if}
            </button>
          </div>
        {/if}

        {#each renderedMessages as msg, index (msg.id)}
          {#if unreadDividerIndex >= 0 && index + renderIndexOffset === unreadDividerIndex}
            <div id="unread-divider" class="my-4 flex items-center gap-3 py-1">
              <div class="h-px flex-1 bg-blue-500/40"></div>
              <span
                class="rounded-full border border-blue-500/30 bg-blue-950/90 px-3 py-1 text-[10px] font-bold tracking-wider text-blue-400 uppercase shadow-md"
              >
                Unread Messages ({initialUnreadCount})
              </span>
              <div class="h-px flex-1 bg-blue-500/40"></div>
            </div>
          {/if}
          {#if currentConv}
            <MessageBubble
              {msg}
              {currentConv}
              isLastReadMyMessage={msg.id === lastReadMyMessageId}
              isReadByOther={isMessageReadByOther(msg)}
            />
          {/if}
        {/each}
        {#if filteredMessages.length === 0}
          <div class="mt-10">
            <EmptyState
              title={inChatSearchQuery.trim()
                ? 'No matching messages found in this chat'
                : 'No messages yet'}
            />
          </div>
        {/if}
      </div>

      <!-- Input Area -->
      <div class="border-t border-gray-700 bg-gray-800/50 p-3 backdrop-blur-md">
        {#if selectedAttachments.length > 0}
          <div class="no-scrollbar mb-2 flex gap-2 overflow-x-auto p-1">
            {#each selectedAttachments as att}
              <div
                class="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-gray-600 shadow-md"
              >
                <img src={att.image} alt="Attachment" class="h-full w-full object-cover" />
                <button
                  class="absolute top-0 right-0 cursor-pointer rounded-bl-lg bg-black/60 p-0.5 text-white hover:bg-black"
                  onclick={() =>
                    (selectedAttachments = selectedAttachments.filter(
                      (a) => a.photo_id !== att.photo_id
                    ))}
                  aria-label="Remove attachment"
                >
                  <CloseIcon class="h-3 w-3" />
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="flex w-full items-center gap-2.5">
          <button
            type="button"
            class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-700/50 hover:text-blue-400"
            onclick={() => (showAttachMenu = !showAttachMenu)}
            aria-label="Attachments"
          >
            <PaperclipIcon class="h-5 w-5" />
          </button>

          <div
            class="flex flex-1 items-center rounded-2xl border border-transparent bg-gray-700/50 px-3.5 py-1.5 text-white focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500"
          >
            <textarea
              class="no-scrollbar h-[22px] max-h-32 min-h-[22px] w-full resize-none bg-transparent p-0 text-sm leading-normal text-white placeholder-gray-400 focus:outline-none"
              placeholder="Message"
              rows="1"
              bind:value={newMessageText}
              onkeydown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}></textarea>
          </div>

          <button
            type="button"
            class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-white shadow-md transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            onclick={handleSendMessage}
            disabled={!newMessageText.trim() && selectedAttachments.length === 0}
            aria-label="Send"
          >
            <SendIcon class="h-4 w-4 text-white" />
          </button>
        </div>

        {#if showAttachMenu}
          <div
            class="absolute bottom-16 left-4 grid w-48 grid-cols-2 gap-2 rounded-xl border border-gray-700 bg-gray-800 p-2 shadow-xl"
            transition:fly={{ y: 20, duration: 200 }}
          >
            <button
              class="flex flex-col items-center justify-center rounded-lg p-3 transition-colors hover:bg-gray-700/50"
              onclick={openPhotoPicker}
            >
              <div
                class="mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-blue-500/20 text-blue-400"
              >
                <PhotoIcon class="h-5 w-5" />
              </div>
              <span class="text-xs">Photo</span>
            </button>
            <button
              class="flex flex-col items-center justify-center rounded-lg p-3 transition-colors hover:bg-gray-700/50"
            >
              <div
                class="mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-green-500/20 text-green-400"
              >
                <LocationIcon class="h-5 w-5" />
              </div>
              <span class="text-xs">Location</span>
            </button>
          </div>
        {/if}
      </div>

      {#if showPhotoPicker}
        <PhotoPickerModal
          title="Select Photos"
          multiSelect={true}
          selectedIds={selectedAttachments.map((a) => a.photo_id)}
          onmultichange={(photoId, image) => {
            const existing = selectedAttachments.find((a) => a.photo_id === photoId);
            if (existing) {
              selectedAttachments = selectedAttachments.filter((a) => a.photo_id !== photoId);
            } else {
              selectedAttachments = [...selectedAttachments, { photo_id: photoId, image }];
            }
          }}
          onclose={() => (showPhotoPicker = false)}
        />
      {/if}
    </div>
  {:else}
    {#if showSearch}
      <!-- Search Dropdown Overlay -->
      <div
        class="animate-in slide-in-from-top sticky top-0 z-20 border-b border-gray-800 bg-gray-900/95 p-3 backdrop-blur-md duration-200"
      >
        <SearchBar bind:value={searchQuery} placeholder="Search chats, names, or messages..." />
      </div>
    {/if}

    <!-- Conversation List -->
    <div class="divide-y divide-gray-800">
      {#each filteredConversations as conv}
        <ListItem
          class="items-start hover:bg-gray-800/40"
          onclick={() => handleSelectConversation(conv.id)}
        >
          <div class="relative mr-4 shrink-0">
            <Avatar
              src={conv.targetAvatar}
              initials={conv.targetName ? conv.targetName[0] : conv.target[0] || '?'}
              size="w-12 h-12"
              textClass="text-lg"
              bgClass={conv.is_group ? 'bg-indigo-700' : 'bg-gray-800 border border-gray-700/60'}
            />
            {#if conv.unreadCount > 0}
              <div
                class="absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full border-2 border-gray-900 bg-blue-500 px-1 text-[10px] font-bold shadow-md"
              >
                {conv.unreadCount}
              </div>
            {/if}
          </div>

          <div class="min-w-0 flex-1">
            <div class="mb-1 flex items-baseline justify-between">
              <span
                class="truncate text-[15px] font-semibold {conv.unreadCount > 0
                  ? 'font-bold text-white'
                  : 'text-gray-200'}"
              >
                {conv.targetName || conv.target}
              </span>
              <span
                class="text-xs {conv.unreadCount > 0
                  ? 'font-semibold text-blue-400'
                  : 'text-gray-500'} ml-2 whitespace-nowrap"
              >
                {formatRelativeTime(conv.lastMessageAt)}
              </span>
            </div>
            <div class="flex items-center">
              {#if conv.last_message?.citizenid === $citizenid}
                <MessageStatusIcon
                  status={isConvLastMsgReadByOther(conv) ? 'read' : 'delivered'}
                  class="mr-1.5 h-3.5 w-3.5 shrink-0"
                />
              {/if}
              <p
                class="flex-1 truncate text-sm {conv.unreadCount > 0
                  ? 'font-medium text-gray-100'
                  : 'text-gray-400'}"
              >
                {conv.lastMessage || 'No messages'}
              </p>
              <ChevronRightIcon
                class="ml-2 h-4 w-4 text-gray-600 opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
          </div>
        </ListItem>
      {/each}

      {#if filteredConversations.length === 0}
        <div class="py-16 text-center">
          <EmptyState
            title={searchQuery.trim()
              ? 'No matching messages found'
              : viewingArchive
                ? 'No archived conversations'
                : 'No active conversations'}
          />
        </div>
      {/if}
    </div>
  {/if}

  {#if showDetailsModal && currentConv}
    <ConversationDetailsModal
      {currentConv}
      onclose={() => (showDetailsModal = false)}
      ondelete={() => {
        showDetailsModal = false;
        selectedConversationId = null;
      }}
    />
  {/if}
</Screen>
