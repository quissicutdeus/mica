<script lang="ts">
  import {
    useAppAction,
    useContacts,
    useMedia,
    usePhoneNotification,
    useNavigation,
    useCall,
    useMessages,
    onAppForeground,
    type Contact,
    FloatingActionButton,
    PhotoPickerModal,
    Screen,
    SearchBar,
    AddIcon,
    SearchIcon,
    filterByQuery,
    useScrollDetect,
    useAppLevels,
    useDeepLink,
    type AppProps
  } from '@gphone/sdk';
  import ContactDetails from './components/ContactDetails.svelte';
  import ContactForm from './components/ContactForm.svelte';
  import ContactList from './components/ContactList.svelte';

  const { openApp } = useNavigation();
  const { callStore } = useCall();
  const { conversationsStore } = useMessages();

  /**
   * `initialContact` opens straight to that contact's details instead of the list.
   *
   * Three callers already passed it — `MessageBubble`, `ConversationDetailsModal` and now
   * the home-screen search — but nothing here declared it, so the prop was accepted by
   * Svelte and silently dropped: every one of those deep links landed on the plain list.
   */
  let { onback, initialContact }: AppProps & { initialContact?: Contact } = $props();

  const { contactsStore } = useContacts();
  const { media } = useMedia();
  const { toast } = usePhoneNotification();
  const { busy, run } = useAppAction('contacts');

  const contacts = contactsStore;
  const contactsLoaded = contactsStore.loaded;

  let isAdding = $state(false);

  // New Contact Form State
  let newContact = $state({
    firstname: '',
    lastname: '',
    phone: '',
    avatar: '',
    favorite: false
  });

  let selectedContact: Contact | null = $state(null);
  let isEditing = $state(false);
  let showPhotoPicker = $state(false);
  let photoPickerTarget: 'new' | 'edit' = $state('new');
  let showSearch = $state(false);
  let searchQuery = $state('');
  let isScrolled = $state(false);

  // Filtered contacts based on search query. The name is searched as one composed string
  // so that "john sm" finds John Smith.
  let filteredContacts = $derived(
    filterByQuery($contacts, searchQuery, (c) => [`${c.firstname} ${c.lastname || ''}`, c.phone])
  );
  let filteredFavorites = $derived(filteredContacts.filter((c) => c.favorite));
  let filteredOther = $derived(filteredContacts.filter((c) => !c.favorite));

  // Derived conversation & recent messages for selected contact
  let matchingConv = $derived(
    selectedContact
      ? $conversationsStore.find(
          (c) =>
            c.target === selectedContact?.phone ||
            c.target === selectedContact?.citizenid ||
            c.participants?.some(
              (p) =>
                p.contact?.phone === selectedContact?.phone ||
                p.citizenid === selectedContact?.citizenid
            )
        )
      : null
  );

  const messageStore = conversationsStore.messages;
  let contactMessages = $derived(matchingConv ? $messageStore[matchingConv.id] || [] : []);

  let recentMessages = $derived(contactMessages.slice(-5).reverse());

  $effect(() => {
    if (selectedContact && matchingConv) {
      conversationsStore.loadMessages(matchingConv.id);
    }
  });

  const openPhotoPicker = (target: 'new' | 'edit') => {
    photoPickerTarget = target;
    media.load();
    showPhotoPicker = true;
  };

  const selectPhoto = (image: string) => {
    if (photoPickerTarget === 'new') {
      newContact.avatar = image;
    } else if (selectedContact) {
      selectedContact.avatar = image;
    }
    showPhotoPicker = false;
  };

  const app = useAppLevels({
    appId: 'contacts',
    title: 'Contacts',
    onback: () => onback(),
    levels: [
      { open: () => showPhotoPicker, close: () => (showPhotoPicker = false) },
      { open: () => isEditing, close: () => (isEditing = false) },
      {
        open: () => !!selectedContact,
        close: () => (selectedContact = null),
        title: 'Contact Details'
      },
      { open: () => isAdding, close: () => (isAdding = false), title: 'New Contact' },
      {
        open: () => showSearch,
        close: () => {
          showSearch = false;
          searchQuery = '';
        }
      }
    ]
  });

  // Same shape as Messages' own deep-link handler: re-run on every foreground so a second
  // arrival at an already-resident app still navigates, and return false once the details
  // for that contact are already showing so a back-out doesn't immediately re-open them.
  useDeepLink('contacts', () => {
    if (initialContact && selectedContact?.id !== initialContact.id) {
      selectedContact = initialContact;
      return true;
    }
    return false;
  });

  const handleMessage = async () => {
    if (!selectedContact) return;
    // We can pass the contact info to Messages app to find/start conversation
    openApp('messages', { initialContact: selectedContact });
  };

  const handleCall = () => {
    if (!selectedContact) return;
    const name = `${selectedContact.firstname} ${selectedContact.lastname || ''}`;
    callStore.startCall(selectedContact.phone, name);
    openApp('phone');
  };

  /** The one rule the server also enforces, checked here so the toast is immediate. */
  const requireNameAndPhone = (firstname?: string, phone?: string, forSharing = false) => {
    if (firstname?.trim() && phone?.trim()) return true;
    toast.show({
      type: 'error',
      app: 'contacts',
      message: forSharing
        ? 'First name and phone number are required to share contact.'
        : 'First name and phone number are required.'
    });
    return false;
  };

  const addContact = async () => {
    if (!requireNameAndPhone(newContact.firstname, newContact.phone)) return;

    const added = await run(
      () =>
        contactsStore.add({
          firstname: newContact.firstname.trim(),
          lastname: newContact.lastname.trim(),
          phone: newContact.phone.trim(),
          avatar: newContact.avatar,
          favorite: newContact.favorite
        }),
      { success: 'Contact added successfully' }
    );
    if (!added) return;

    isAdding = false;
    newContact = {
      firstname: '',
      lastname: '',
      phone: '',
      avatar: '',
      favorite: false
    };
  };

  const updateContact = async () => {
    if (!selectedContact) return false;
    if (!requireNameAndPhone(selectedContact.firstname, selectedContact.phone)) return false;

    // Sanitize payload to only include updatable fields
    const payload = {
      id: selectedContact.id, // ID is required for update in ServiceEndpoint
      firstname: selectedContact.firstname.trim(),
      lastname: selectedContact.lastname ? selectedContact.lastname.trim() : '',
      phone: selectedContact.phone.trim(),
      favorite: selectedContact.favorite,
      avatar: selectedContact.avatar,
      citizenid: selectedContact.citizenid, // Required for type safety
      created_at: selectedContact.created_at,
      updated_at: new Date().toISOString()
    };

    const saved = await run(() => contactsStore.update(payload), {
      success: 'Contact updated successfully'
    });
    if (saved) isEditing = false;
    return saved;
  };

  const toggleFavorite = async () => {
    if (!selectedContact) return;
    selectedContact.favorite = !selectedContact.favorite;
    // Put the star back if the write did not land, rather than showing a state the
    // server does not have.
    if (!(await updateContact()) && selectedContact) {
      selectedContact.favorite = !selectedContact.favorite;
    }
  };

  const deleteContact = async () => {
    if (!selectedContact) return;
    // This one used to swallow both toasts, so a refused delete looked like a real one.
    const deleted = await run(() => contactsStore.delete(selectedContact!.id), {
      success: 'Contact deleted'
    });
    if (deleted) selectedContact = null;
  };

  const shareContact = async () => {
    if (!selectedContact) return;
    if (!requireNameAndPhone(selectedContact.firstname, selectedContact.phone, true)) return;

    // No success toast here: the callback resolves optimistically the instant the
    // request leaves the phone, before the server has looked for anyone nearby. The
    // real outcome — delivered to N phones, or nobody in range — arrives afterward as
    // its own pushed toast (`share_result`, `server/services/Contacts.ts`), and a
    // second, unconditional "success" here would be the exact lie this flow used to
    // tell before proximity sharing existed.
    await run(() =>
      contactsStore.share({
        name: `${selectedContact!.firstname.trim()} ${selectedContact!.lastname?.trim() || ''}`.trim(),
        firstname: selectedContact!.firstname.trim(),
        lastname: selectedContact!.lastname?.trim() || '',
        phone: selectedContact!.phone.trim(),
        avatar: selectedContact!.avatar || ''
      })
    );
  };

  onAppForeground('contacts', () => {
    void contactsStore.load();
    void conversationsStore.loadConversations();
  });

  useScrollDetect((v) => (isScrolled = v));
</script>

{#snippet headerActions()}
  {#if !selectedContact && !isAdding}
    <button
      class="hover:bg-surface-container-high ml-auto rounded-full p-2 transition-colors {showSearch
        ? 'bg-surface-container text-primary'
        : 'text-on-surface'} duration-short ease-standard"
      onclick={() => {
        showSearch = !showSearch;
        if (!showSearch) searchQuery = '';
      }}
      title="Search Contacts"
      aria-label="Search Contacts"
    >
      <SearchIcon class="size-icon-md" />
    </button>
  {/if}
{/snippet}

{#snippet fabOverlay()}
  {#if !selectedContact && !isAdding}
    <FloatingActionButton
      label="Add Contact"
      collapsed={isScrolled}
      onclick={() => (isAdding = true)}
    >
      {#snippet icon()}
        <AddIcon class="text-on-surface size-icon-sm shrink-0" />
      {/snippet}
    </FloatingActionButton>
  {/if}
{/snippet}

<Screen title={app.title} onback={app.back} actions={headerActions} overlay={fabOverlay}>
  {#if !selectedContact}
    {#if isAdding}
      <ContactForm
        draft={newContact}
        busy={$busy}
        onsave={addContact}
        oncancel={() => (isAdding = false)}
        onpickphoto={() => openPhotoPicker('new')}
      />
    {/if}

    {#if showSearch}
      <div
        class="animate-in slide-in-from-top border-outline-variant bg-surface duration-medium ease-emphasized sticky top-0 z-20 border-b p-3 backdrop-blur-md"
      >
        <SearchBar bind:value={searchQuery} placeholder="Search contacts..." focus={true} />
      </div>
    {/if}

    <ContactList
      favorites={filteredFavorites}
      others={filteredOther}
      total={filteredContacts.length}
      loaded={$contactsLoaded}
      query={searchQuery}
      onselect={(contact: Contact) => (selectedContact = contact)}
    />
  {:else}
    <ContactDetails
      contact={selectedContact}
      {isEditing}
      busy={$busy}
      {recentMessages}
      messageCount={contactMessages.length}
      oncall={handleCall}
      onmessage={handleMessage}
      onshare={shareContact}
      ondelete={deleteContact}
      onsave={updateContact}
      ontogglefavorite={toggleFavorite}
      onpickphoto={() => openPhotoPicker('edit')}
      onedit={() => (isEditing = !isEditing)}
    />
  {/if}

  <!-- Photo Gallery Picker Modal -->
  {#if showPhotoPicker}
    <PhotoPickerModal
      title="Select Contact Photo"
      showRemove={(photoPickerTarget === 'new' && !!newContact.avatar) ||
        (photoPickerTarget === 'edit' && !!selectedContact?.avatar)}
      onselect={selectPhoto}
      onclose={() => (showPhotoPicker = false)}
    />
  {/if}
</Screen>
