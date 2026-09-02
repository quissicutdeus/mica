<!--
SPDX-FileCopyrightText: 2025 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

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
    registerMessages,
    useLocale,
    type AppProps
  } from '@gphone/sdk';
  import type { Contact, MediaPreview } from '@gphone/shared/types';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-215: this app's strings, registered by the app itself — the same shape an
  // add-on outside this repository uses. `$t('messages.…')` reads them under the phone's
  // locale, here and in the four components below.
  registerMessages('messages', { en, de });
  const { t } = useLocale();

  const { conversationsStore, messageReactions, loadMessageReactions, toggleMessageReaction } =
    useMessages();
  const conversationsLoaded = conversationsStore.loaded;
  const conversationsHasMore = conversationsStore.hasMore;
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
    phone,
    startNew
  }: AppProps & {
    initialContact?: Contact;
    conversationId?: number;
    phone?: string;
    startNew?: boolean;
  } = $props();

  // Local state for UI
  let selectedConversationId: number | null = $state(null);
  let isComposing = $state(false);
  let newMessageText = $state('');
  let recipientQuery = $state(''); // For searching contacts when composing
  let showAttachMenu = $state(false);
  let showPhotoPicker = $state(false);
  let selectedAttachments = $state<{ photo_id: number; media: MediaPreview }[]>([]);
  let replyingToMsg = $state<UIMessage | null>(null);
  /**
   * The message currently being rewritten, and the draft it displaced.
   *
   * `draftBeforeEdit` exists because the composer is one box: starting an edit puts the
   * old message's text in it, and a player who cancels should get back whatever they had
   * been typing rather than an empty field or, worse, the edited message's words.
   */
  let editingMsg = $state<UIMessage | null>(null);
  let draftBeforeEdit = '';
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

  /**
   * Reactions for whatever page of the thread is actually on screen, not the whole
   * conversation — matching the windowing `page` already does, so opening a long thread
   * does not fetch reaction counts for messages nobody has scrolled to yet.
   */
  $effect(() => {
    const ids = renderedMessages.map((m) => m.id);
    if (ids.length > 0) void loadMessageReactions(ids);
  });

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
    editingMsg = null;
    draftBeforeEdit = '';
    unreadDividerIndex = -1;
    page.reset();
  };

  /**
   * Start rewriting one of your own messages.
   *
   * Replying and editing are mutually exclusive — the composer sends to one destination —
   * so beginning an edit drops a pending reply rather than leaving two banners stacked
   * above a single box, each claiming the next Send.
   */
  const startEdit = (msg: UIMessage) => {
    draftBeforeEdit = editingMsg ? draftBeforeEdit : newMessageText;
    editingMsg = msg;
    replyingToMsg = null;
    newMessageText = msg.message;
  };

  const cancelEdit = () => {
    editingMsg = null;
    newMessageText = draftBeforeEdit;
    draftBeforeEdit = '';
  };

  /**
   * Unsend, which is a delete for everyone rather than a hide for the sender — see the
   * `delete` action in `server/services/Messages.ts`. The bubble has already asked.
   */
  const handleUnsendMessage = async (msg: UIMessage) => {
    if (!selectedConversationId) return;
    if (editingMsg?.id === msg.id) cancelEdit();
    await run(() => conversationsStore.deleteMessage(selectedConversationId!, msg.id), {
      success: $t('messages.unsent'),
      error: $t('messages.unsendFailed')
    });
  };

  const app = useAppLevels({
    appId: 'messages',
    title: () => {
      if (isComposing) return $t('messages.newMessage');
      if (currentConv) return currentConv.targetName || currentConv.target;
      if (selectedConversationId) return $t('messages.chat');
      return viewingArchive ? $t('messages.archivedTitle') : $t('messages.title');
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
      // Above the conversation level, so Back out of an edit returns you to the thread
      // with your original draft rather than closing the thread outright.
      { open: () => !!editingMsg, close: cancelEdit },
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

  const handleStartTextRaw = async (phone: string) => {
    // Check if conversation already exists
    const existing = $conversationsStore.find((c) => c.target === phone);
    if (existing) {
      handleSelectConversation(existing.id);
      isComposing = false;
    } else {
      // Start new conversation via store
      let newConv: Awaited<ReturnType<typeof conversationsStore.startConversation>> | undefined;
      const started = await run(async () => {
        newConv = await conversationsStore.startConversation(phone);
      });
      if (started && newConv) {
        selectedConversationId = newConv.id;
        isComposing = false;
      }
    }
  };

  const handleSelectContactRaw = (contact: Contact) => handleStartTextRaw(contact.phone);

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
        'rounded-box'
      );
      setTimeout(() => {
        targetEl.classList.remove(
          'ring-2',
          'ring-primary',
          'bg-surface-container-highest',
          'rounded-box'
        );
      }, 1500);
    }
  };

  const handleSendMessage = async () => {
    if (!selectedConversationId) return;

    /**
     * The same Send button, two destinations.
     *
     * Splitting them into two rows was the alternative and it is worse: a second composer
     * would need its own attachment gate, its own home-indicator clearance and its own
     * Enter handling, and the player would be looking at two text boxes with one draft
     * between them.
     */
    if (editingMsg) {
      const text = newMessageText.trim();
      if (!text) return;
      const target = editingMsg;
      const saved = await run(
        () => conversationsStore.editMessage(selectedConversationId!, target.id, text),
        { success: $t('messages.edited'), error: $t('messages.editFailed') }
      );
      if (!saved) return;
      editingMsg = null;
      newMessageText = draftBeforeEdit;
      draftBeforeEdit = '';
      return;
    }

    if (!newMessageText.trim() && selectedAttachments.length === 0) return;

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

  /**
   * Ask for the next page of the inbox.
   *
   * The busy flag is here rather than read off the store because it is a statement about
   * this button: `createPagedStore.loadMore` already refuses to overlap itself, but a second
   * click that quietly resolved `false` would just look broken.
   */
  let loadingMoreConversations = $state(false);
  const loadMoreConversations = async () => {
    if (loadingMoreConversations) return;
    loadingMoreConversations = true;
    try {
      await conversationsStore.loadMoreConversations();
    } finally {
      loadingMoreConversations = false;
    }
  };

  // Load conversations on mount; deep-link navigation is handled by the $effect below.
  // The refetch is also what gives back every held thread but the one on screen — see
  // `MAX_CACHED_THREADS` in `services/conversations.ts` for why the release rides here.
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
      if (existing) {
        handleSelectConversation(existing.id);
        return true;
      }
      if (startNew && !isComposing) {
        void handleStartTextRaw(phone);
        return true;
      }
      return false;
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
        title={viewingArchive ? $t('messages.viewInbox') : $t('messages.viewArchive')}
        aria-label={$t('messages.toggleArchive')}
      >
        <ArchiveIcon class="size-icon-md" />
      </button>
      <button
        class="hover:bg-surface-container-high rounded-full p-2 transition-colors {showSearch
          ? 'bg-surface-container text-primary'
          : 'text-on-surface'} duration-short ease-standard"
        onclick={() => {
          showSearch = !showSearch;
          if (!showSearch) searchQuery = '';
        }}
        title={$t('messages.searchMessages')}
        aria-label={$t('messages.searchMessages')}
      >
        <SearchIcon class="size-icon-md" />
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
        title={$t('messages.deleteConversation')}
        aria-label={$t('messages.deleteConversation')}
      >
        <TrashIcon class="size-icon-md" />
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
        title={currentConv.status === 'archived'
          ? $t('messages.unarchive')
          : $t('messages.archive')}
        aria-label={$t('messages.archiveConversation')}
      >
        <ArchiveIcon class="size-icon-md" />
      </button>
      <button
        class="hover:bg-surface-container-high cursor-pointer rounded-full p-1.5 transition-colors {showInChatSearch
          ? 'bg-surface-container text-primary'
          : 'text-on-surface hover:text-on-surface'} duration-short ease-standard"
        onclick={() => {
          showInChatSearch = !showInChatSearch;
          if (!showInChatSearch) inChatSearchQuery = '';
        }}
        title={$t('messages.searchMessages')}
        aria-label={$t('messages.searchMessages')}
      >
        <SearchIcon class="size-icon-md" />
      </button>
    </div>
  {/if}
{/snippet}

{#snippet fabOverlay()}
  {#if !selectedConversationId && !isComposing}
    <FloatingActionButton
      label={$t('messages.startChat')}
      collapsed={isScrolled}
      onclick={startNewMessage}
    >
      {#snippet icon()}
        <MessageIcon class="text-on-surface size-icon-sm shrink-0" />
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
          <h3 class="text-on-surface text-body-large">{$t('messages.newConversation')}</h3>
          <button
            type="button"
            class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard rounded-full p-1 transition-colors"
            onclick={() => (isComposing = false)}
            aria-label={$t('messages.closeForm')}
          >
            <CloseIcon class="size-icon-md" />
          </button>
        </div>

        <SearchBar
          bind:value={recipientQuery}
          placeholder={$t('messages.recipientPlaceholder')}
          focus={true}
        />

        <div
          class="divide-outline-variant bg-surface-container max-h-56 divide-y overflow-y-auto rounded-box p-1"
        >
          {#each filteredContacts as contact (contact.id)}
            <ListItem
              class="hover:bg-surface-container rounded-box py-2"
              onclick={() => handleSelectContactRaw(contact)}
            >
              <div class="mr-3 shrink-0">
                <Avatar src={contact.avatar} initials={contact.firstname[0]} size="w-9 h-9" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-on-surface text-body-medium truncate">
                  {contact.firstname}
                  {contact.lastname || ''}
                </div>
                <div class="text-on-surface-variant text-body-small">
                  {contact.phone}
                </div>
              </div>
            </ListItem>
          {/each}
          {#if filteredContacts.length === 0}
            <div class="text-on-surface-variant text-body-small py-6 text-center">
              {$t('messages.noMatchingContacts')}
            </div>
          {/if}
        </div>

        <Button
          variant="secondary"
          class="text-body-small w-full"
          onclick={() => (isComposing = false)}
        >
          {$t('messages.cancel')}
        </Button>
      </div>
    {/if}
  {/if}

  {#if selectedConversationId}
    <!-- Chat View -->
    <div class="bg-surface flex min-h-0 flex-1 flex-col">
      {#if showInChatSearch}
        <!-- In-Chat Search Bar -->
        <div class="border-outline-variant bg-surface border-b p-2 backdrop-blur-md">
          <SearchBar
            bind:value={inChatSearchQuery}
            placeholder={$t('messages.searchInConversation')}
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
        onreply={(msg: UIMessage) => (replyingToMsg = msg)}
        onscrollto={handleScrollToMessage}
        onedit={startEdit}
        ondelete={handleUnsendMessage}
        onloadmore={page.loadMore}
        onscroll={page.onScroll}
        unreadCount={initialUnreadCount}
        searching={!!inChatSearchQuery.trim()}
        reactions={$messageReactions}
        ontogglereaction={toggleMessageReaction}
      />

      <MessageComposer
        bind:text={newMessageText}
        bind:attachments={selectedAttachments}
        replyingTo={replyingToMsg}
        editing={editingMsg}
        {currentConv}
        busy={$busy}
        onsend={handleSendMessage}
        onopenphotos={openPhotoPicker}
        oncancelreply={() => (replyingToMsg = null)}
        oncanceledit={cancelEdit}
      />
    </div>
  {:else}
    <ConversationList
      conversations={filteredConversations}
      loaded={$conversationsLoaded}
      hasMore={$conversationsHasMore}
      loadingMore={loadingMoreConversations}
      bind:query={searchQuery}
      {showSearch}
      {viewingArchive}
      myCitizenId={$citizenid}
      isLastMsgReadByOther={isConvLastMsgReadByOther}
      onselect={handleSelectConversation}
      onloadmore={loadMoreConversations}
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
