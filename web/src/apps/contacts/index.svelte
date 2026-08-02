<script lang="ts">
  import {
    useAppAction,
    useContacts,
    usePhotos,
    usePhoneNotification,
    useNuiBridge,
    useNavigation,
    useCall,
    useMessages,
    onAppForeground,
    type Contact,
    Avatar,
    Button,
    FloatingActionButton,
    ListItem,
    PhotoPickerModal,
    Screen,
    SearchBar,
    Skeleton,
    AddIcon,
    ChevronRightIcon,
    CloseIcon,
    EditIcon,
    MessageIcon,
    PhoneIcon,
    SearchIcon,
    ShareIcon,
    StarIcon,
    TrashIcon,
    filterByQuery,
    formatRelativeTime,
    useScrollDetect,
    useAppLevels
  } from '@gphone/sdk';
  import ContactDetails from './components/ContactDetails.svelte';
  import ContactForm from './components/ContactForm.svelte';
  import ContactList from './components/ContactList.svelte';

  const { openApp } = useNavigation();
  const { callStore } = useCall();
  const { conversationsStore } = useMessages();

  let { onback } = $props();

  const { contactsStore, favoriteContacts } = useContacts();
  const { photos } = usePhotos();
  const { sendNotification, toast } = usePhoneNotification();
  const { fetchNui } = useNuiBridge();
  const { busy, run } = useAppAction();

  const contacts = contactsStore;
  const contactsLoaded = contactsStore.loaded;

  // Derive other contacts from the main store
  let otherContacts = $derived($contacts.filter((c: Contact) => !c.favorite));
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
    photos.load();
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
    title: 'Contacts',
    onback: () => onback?.(),
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

    await run(
      () =>
        contactsStore.share({
          name: `${selectedContact!.firstname.trim()} ${selectedContact!.lastname?.trim() || ''}`.trim(),
          firstname: selectedContact!.firstname.trim(),
          lastname: selectedContact!.lastname?.trim() || '',
          phone: selectedContact!.phone.trim(),
          avatar: selectedContact!.avatar || ''
        }),
      { success: 'Contact shared successfully' }
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
      class="ml-auto rounded-full p-2 transition-colors hover:bg-gray-700 {showSearch
        ? 'bg-gray-800 text-blue-400'
        : 'text-gray-300'}"
      onclick={() => {
        showSearch = !showSearch;
        if (!showSearch) searchQuery = '';
      }}
      title="Search Contacts"
      aria-label="Search Contacts"
    >
      <SearchIcon class="h-5 w-5" />
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
        <AddIcon class="h-4 w-4 shrink-0 text-white" />
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
        class="animate-in slide-in-from-top sticky top-0 z-20 border-b border-gray-800 bg-gray-900/95 p-3 backdrop-blur-md duration-200"
      >
        <SearchBar bind:value={searchQuery} placeholder="Search contacts..." />
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
