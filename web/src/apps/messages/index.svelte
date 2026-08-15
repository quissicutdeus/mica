<script lang="ts">
  import { tick } from 'svelte';
  import {
    useMessages,
    useContacts,
    useMedia,
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
    FloatingActionButton,
    ListItem,
    Screen,
    SearchBar,
    ArchiveIcon,
    CloseIcon,
    MessageIcon,
    SearchIcon,
    TrashIcon,
    filterByQuery,
    useScrollDetect,
    type AppProps
  } from '@gphone/sdk';
  import type { Contact, MediaPreview } from '@shared/types';

  const { conversationsStore } = useMessages();
  const conversationsLoaded = conversationsStore.loaded;
  const { busy, run } = useAppAction('messages');
  const { contactsStore: contacts } = useContacts();
  const { media } = useMedia();
  const { citizenid } = useAccount();
  import ConversationList from './components/ConversationList.svelte';
  import MessageComposer from './components/MessageComposer.svelte';
  import MessageThread from './components/MessageThread.svelte';
  import ConversationDetailsModal from './components/ConversationDetailsModal.svelte';

  let {
    onback,
    initialContact,
    conversationId,
    phone
  }: AppProps & { initialContact?: Contact; conversationId?: number; phone?: string } = $props();

  // Local state for UI
  let selectedConversationId: number | null = $state(null);
  let isComposing = $state(false);
  let newMessageText = $state('');
  let recipientQuery = $state(''); // For searching contacts when composing
  let showAttachMenu = $state(false);
  let showPhotoPicker = $state(false);
  let selectedAttachments = $state<{ photo_id: number; media: MediaPreview }[]>([]);
  let replyingToMsg = $state<UIMessage | null>(null);
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
    replyingToMsg = null;
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
    onback: () => onback(),
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
    await media.load();
    showPhotoPicker = true;
    showAttachMenu = false;
  };

  const handleScrollToMessage = (msgId: number) => {
    const targetEl = document.getElementById(`msg-${msgId}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add(
        'ring-2',
        'ring-primary',
        'bg-surface-container-highest',
        'rounded-lg'
      );
      setTimeout(() => {
        targetEl.classList.remove(
          'ring-2',
          'ring-primary',
          'bg-surface-container-highest',
          'rounded-lg'
        );
      }, 1500);
    }
  };

  const handleSendMessage = async () => {
    if ((!newMessageText.trim() && selectedAttachments.length === 0) || !selectedConversationId)
      return;

    // The draft survives a failure: clearing it before the server has taken the message
    // would lose what the player typed with nothing to show for it.
    const replyId = replyingToMsg?.id;
    const sent = await run(() =>
      conversationsStore.sendMessage(
        selectedConversationId!,
        newMessageText,
        // `photo_id` only. The server resolves the row and projects what a reader is
        // allowed to see; sending the preview back would be the client telling the server
        // what its own table says.
        selectedAttachments.map((att) => ({ photo_id: att.photo_id })),
        replyId
      )
    );
    if (!sent) return;

    newMessageText = '';
    selectedAttachments = [];
    replyingToMsg = null;
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
</script>

{#snippet headerActions()}
  {#if !selectedConversationId && !isComposing}
    <div class="ml-auto flex items-center gap-1">
      <button
        class="hover:bg-surface rounded-full p-2 transition-colors {viewingArchive
          ? 'bg-surface-container-low text-primary'
          : 'text-on-surface'} duration-short ease-standard"
        onclick={() => (viewingArchive = !viewingArchive)}
        title={viewingArchive ? 'View Inbox' : 'View Archive'}
        aria-label="Toggle Archive"
      >
        <ArchiveIcon class="h-5 w-5" />
      </button>
      <button
        class="hover:bg-surface-container-high rounded-full p-2 transition-colors {showSearch
          ? 'bg-surface-container text-primary'
          : 'text-on-surface'} duration-short ease-standard"
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
        class="text-on-surface hover:bg-surface-container-high hover:text-error duration-short ease-standard cursor-pointer rounded-full p-1.5 transition-colors"
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
        class="text-on-surface hover:bg-surface-container-high hover:text-primary duration-short ease-standard cursor-pointer rounded-full p-1.5 transition-colors"
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
        class="hover:bg-surface-container-high cursor-pointer rounded-full p-1.5 transition-colors {showInChatSearch
          ? 'bg-surface-container text-primary'
          : 'text-on-surface hover:text-on-surface'} duration-short ease-standard"
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
        <MessageIcon class="text-on-surface h-4 w-4 shrink-0" />
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
        class="animate-in slide-in-from-top border-outline-variant bg-surface shadow-elevation-5 duration-medium ease-emphasized sticky top-0 z-20 space-y-3 border-b p-4 backdrop-blur-md"
      >
        <div class="border-outline-variant flex items-center justify-between border-b pb-1">
          <h3 class="text-on-surface text-base font-semibold">New Conversation</h3>
          <button
            type="button"
            class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard rounded-full p-1 transition-colors"
            onclick={() => (isComposing = false)}
            aria-label="Close form"
          >
            <CloseIcon class="h-5 w-5" />
          </button>
        </div>

        <SearchBar
          bind:value={recipientQuery}
          placeholder="To: Name or Phone Number"
          focus={true}
        />

        <div
          class="divide-outline-variant bg-surface-container max-h-56 divide-y overflow-y-auto rounded-xl p-1"
        >
          {#each filteredContacts as contact}
            <ListItem
              class="hover:bg-surface-container rounded-lg py-2"
              onclick={() => handleSelectContactRaw(contact)}
            >
              <div class="mr-3 shrink-0">
                <Avatar src={contact.avatar} initials={contact.firstname[0]} size="w-9 h-9" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-on-surface truncate text-sm font-medium">
                  {contact.firstname}
                  {contact.lastname || ''}
                </div>
                <div class="text-on-surface-variant text-xs">
                  {contact.phone}
                </div>
              </div>
            </ListItem>
          {/each}
          {#if filteredContacts.length === 0}
            <div class="text-on-surface-variant py-6 text-center text-xs">
              No matching contacts found.
            </div>
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
    <div class="bg-surface flex h-full flex-col">
      {#if showInChatSearch}
        <!-- In-Chat Search Bar -->
        <div class="border-outline-variant bg-surface border-b p-2 backdrop-blur-md">
          <SearchBar
            bind:value={inChatSearchQuery}
            placeholder="Search in conversation..."
            focus={true}
          />
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
        onreply={(msg) => (replyingToMsg = msg)}
        onscrollto={handleScrollToMessage}
        onloadmore={page.loadMore}
        onscroll={page.onScroll}
        unreadCount={initialUnreadCount}
        searching={!!inChatSearchQuery.trim()}
      />

      <MessageComposer
        bind:text={newMessageText}
        bind:attachments={selectedAttachments}
        replyingTo={replyingToMsg}
        {currentConv}
        busy={$busy}
        onsend={handleSendMessage}
        onopenphotos={openPhotoPicker}
        oncancelreply={() => (replyingToMsg = null)}
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
