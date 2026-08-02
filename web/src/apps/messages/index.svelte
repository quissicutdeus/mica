<script lang="ts">
  import { tick } from 'svelte';
  import {
    useMessages,
    useContacts,
    usePhotos,
    useAccount,
    onAppForeground,
    useAppAction,
    useAppLevels,
    useDeepLink,
    usePagedList,
    type UIMessage,
    type UIConversation,
    Avatar,
    Button,
    EmptyState,
    FloatingActionButton,
    ListItem,
    PhotoPickerModal,
    Screen,
    SearchBar,
    Skeleton,
    ArchiveIcon,
    ChevronRightIcon,
    CloseIcon,
    LocationIcon,
    MessageIcon,
    MessageStatusIcon,
    PaperclipIcon,
    PhotoIcon,
    SearchIcon,
    SendIcon,
    TrashIcon,
    filterByQuery,
    formatRelativeTime,
    useScrollDetect
  } from '@gphone/sdk';
  import { fly } from 'svelte/transition';
  import type { Contact, Photo } from '@shared/types';

  const { conversationsStore } = useMessages();
  const conversationsLoaded = conversationsStore.loaded;
  const { busy, run } = useAppAction();
  const { contactsStore: contacts } = useContacts();
  const { photos } = usePhotos();
  const { citizenid } = useAccount();
  import ConversationList from './components/ConversationList.svelte';
  import MessageComposer from './components/MessageComposer.svelte';
  import MessageThread from './components/MessageThread.svelte';
  import ConversationDetailsModal from './components/ConversationDetailsModal.svelte';

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
  let conversations = $derived($conversationsStore);

  // Store already sorts newest-first on load/send, no need to re-sort here
  let activeConversations = $derived(
    conversations.filter((c) => (c.status || 'active') === 'active')
  );
  let archivedConversations = $derived(conversations.filter((c) => c.status === 'archived'));
  let displayedConversations = $derived(
    viewingArchive ? archivedConversations : activeConversations
  );
  let filteredConversations = $derived(
    filterByQuery(displayedConversations, searchQuery, (c) => [
      c.targetName,
      c.target,
      c.lastMessage
    ])
  );
  let currentConv = $derived(
    selectedConversationId ? conversations.find((c) => c.id === selectedConversationId) : null
  );

  // Derived messages for current conversation
  // We must subscribe to the inner store
  const messageStore = conversationsStore.messages;
  let messages = $derived(
    selectedConversationId ? $messageStore[selectedConversationId] || [] : []
  );
  let filteredMessages = $derived(filterByQuery(messages, inChatSearchQuery, (m) => [m.message]));

  /**
   * The thread is revealed a page at a time, newest first, with the scroll anchoring
   * that stops the view jumping when older messages appear above the fold.
   *
   * In-chat search bypasses the window: a match is worth finding wherever it is, and a
   * search that only looked at the last fifty messages would be quietly wrong.
   */
  const page = usePagedList<UIMessage>({
    items: () => (inChatSearchQuery.trim() ? [] : filteredMessages),
    olderAt: 'start',
    container: () => document.getElementById('messages-container')
  });

  const renderedMessages = $derived(inChatSearchQuery.trim() ? filteredMessages : page.visible);
  const renderIndexOffset = $derived(inChatSearchQuery.trim() ? 0 : page.offset);

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
    filterByQuery($contacts, recipientQuery, (c) => [c.firstname, c.lastname, c.phone])
  );

  /**
   * Leaving a thread clears everything scoped to that thread.
   *
   * Its own level rather than one rung that resets everything: the composer, the photo
   * picker and the in-chat search are separate screens and close one at a time, but the
   * draft and the unread divider belong to the conversation and cannot outlive it.
   */
  const closeConversation = () => {
    selectedConversationId = null;
    conversationsStore.setActiveConversationId(null);
    isComposing = false;
    newMessageText = '';
    recipientQuery = '';
    selectedAttachments = [];
    unreadDividerIndex = -1;
    page.reset();
  };

  const app = useAppLevels({
    appId: 'messages',
    title: () => {
      if (isComposing) return 'New Message';
      if (currentConv) return currentConv.targetName || currentConv.target;
      if (selectedConversationId) return 'Chat';
      return viewingArchive ? 'Archived Messages' : 'Messages';
    },
    onback: () => onback?.(),
    levels: [
      { open: () => showDetailsModal, close: () => (showDetailsModal = false) },
      { open: () => showPhotoPicker, close: () => (showPhotoPicker = false) },
      { open: () => showAttachMenu, close: () => (showAttachMenu = false) },
      {
        open: () => showInChatSearch,
        close: () => {
          showInChatSearch = false;
          inChatSearchQuery = '';
        }
      },
      { open: () => !!selectedConversationId || isComposing, close: closeConversation },
      {
        open: () => showSearch,
        close: () => {
          showSearch = false;
          searchQuery = '';
        }
      },
      { open: () => viewingArchive, close: () => (viewingArchive = false) }
    ]
  });

  const handleTitleClick = () => {
    if (selectedConversationId && currentConv) {
      showDetailsModal = true;
    }
  };

  const handleSelectConversation = async (id: number) => {
    page.reset();
    const conv = $conversationsStore.find((c) => c.id === id);
    initialUnreadCount = conv?.unreadCount || 0;
    selectedConversationId = id;
    await conversationsStore.loadMessages(id);

    const msgs = $messageStore[id] || [];
    if (initialUnreadCount > 0 && msgs.length > 0) {
      unreadDividerIndex = Math.max(0, msgs.length - initialUnreadCount);
    } else {
      unreadDividerIndex = -1;
    }

    await tick();

    if (initialUnreadCount > 0) {
      scrollToUnreadDivider();
      await conversationsStore.markAsRead(id);
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
    const existing = $conversationsStore.find((c) => c.target === contact.phone);
    if (existing) {
      handleSelectConversation(existing.id);
      isComposing = false;
    } else {
      // Start new conversation via store
      let newConv: Awaited<ReturnType<typeof conversationsStore.startConversation>> | undefined;
      const started = await run(async () => {
        newConv = await conversationsStore.startConversation(contact.phone);
      });
      if (started && newConv) {
        selectedConversationId = newConv.id;
        isComposing = false;
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

    // The draft survives a failure: clearing it before the server has taken the message
    // would lose what the player typed with nothing to show for it.
    const sent = await run(() =>
      conversationsStore.sendMessage(
        selectedConversationId!,
        newMessageText,
        selectedAttachments.map((att) => ({
          photo_id: att.photo_id,
          attachment: att.image
        }))
      )
    );
    if (!sent) return;

    newMessageText = '';
    selectedAttachments = [];
    await tick();
    scrollToBottom();
  };

  const scrollToBottom = () => {
    const el = document.getElementById('messages-container');
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Load conversations on mount; deep-link navigation is handled by the $effect below
  onAppForeground('messages', () => {
    void conversationsStore.loadConversations();
  });

  useDeepLink('messages', () => {
    if (conversationId && conversationId !== selectedConversationId) {
      handleSelectConversation(conversationId);
      return true;
    }
    if (phone && (!currentConv || currentConv.target !== phone)) {
      const existing = $conversationsStore.find((c) => c.target === phone);
      if (!existing) return false;
      handleSelectConversation(existing.id);
      return true;
    }
    if (initialContact && !selectedConversationId && !isComposing) {
      handleSelectContactRaw(initialContact);
      return true;
    }
    return false;
  });

  useScrollDetect((v) => (isScrolled = v));

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
            await conversationsStore.deleteConversation(currentConv.id);
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
            await conversationsStore.archiveConversation(currentConv.id, !isArchived);
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
  title={app.title}
  onback={app.back}
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
        <div class="border-b border-gray-800 bg-gray-900/95 p-2 backdrop-blur-md">
          <SearchBar bind:value={inChatSearchQuery} placeholder="Search in conversation..." />
        </div>
      {/if}

      <MessageThread
        messages={renderedMessages}
        offset={renderIndexOffset}
        hiddenCount={page.hiddenCount}
        loadingMore={page.loading}
        {unreadDividerIndex}
        {currentConv}
        {lastReadMyMessageId}
        isReadByOther={isMessageReadByOther}
        onloadmore={page.loadMore}
        onscroll={page.onScroll}
        unreadCount={initialUnreadCount}
        searching={!!inChatSearchQuery.trim()}
      />

      <MessageComposer
        bind:text={newMessageText}
        bind:attachments={selectedAttachments}
        busy={$busy}
        onsend={handleSendMessage}
        onopenphotos={openPhotoPicker}
      />
    </div>
  {:else}
    <ConversationList
      conversations={filteredConversations}
      loaded={$conversationsLoaded}
      bind:query={searchQuery}
      {showSearch}
      {viewingArchive}
      myCitizenId={$citizenid}
      isLastMsgReadByOther={isConvLastMsgReadByOther}
      onselect={handleSelectConversation}
    />
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
