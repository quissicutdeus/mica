<script lang="ts">
  import {
    useContacts,
    useCamera,
    usePhoneNotification,
    useNuiBridge,
    useNavigation,
    useCall,
    useMessages,
    onAppMount,
    type Contact,
    Avatar,
    Button,
    FloatingActionButton,
    ListItem,
    PhotoPickerModal,
    Screen,
    SearchBar,
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
    formatRelativeTime,
    useScrollDetect,
    useKeybinds
  } from '@gphone/sdk';

  const { openApp } = useNavigation();
  const { callStore } = useCall();
  const { messagesStore } = useMessages();

  let { onback } = $props();

  const { contactsStore, favoriteContacts } = useContacts();
  const { photosStore: photos } = useCamera();
  const { sendNotification, toast } = usePhoneNotification();
  const { fetchNui } = useNuiBridge();
  const { onKeybind } = useKeybinds();

  const contacts = contactsStore;

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

  // Filtered contacts based on search query
  let filteredContacts = $derived(
    searchQuery.trim()
      ? $contacts.filter(
          (c) =>
            `${c.firstname} ${c.lastname || ''}`
              .toLowerCase()
              .includes(searchQuery.toLowerCase()) || c.phone.includes(searchQuery.trim())
        )
      : $contacts
  );
  let filteredFavorites = $derived(filteredContacts.filter((c) => c.favorite));
  let filteredOther = $derived(filteredContacts.filter((c) => !c.favorite));

  // Derived conversation & recent messages for selected contact
  let matchingConv = $derived(
    selectedContact
      ? $messagesStore.find(
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

  const messageStore = messagesStore.messages;
  let contactMessages = $derived(matchingConv ? $messageStore[matchingConv.id] || [] : []);

  let recentMessages = $derived(contactMessages.slice(-5).reverse());

  $effect(() => {
    if (selectedContact && matchingConv) {
      messagesStore.loadMessages(matchingConv.id);
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

  /**
   * Backspace steps up one level before it will leave the app. The shell owns the key,
   * so wiring `goBack` only to `<Screen onback>` let it jump straight home.
   */
  const goBack = () => {
    if (selectedContact) {
      selectedContact = null;
      isEditing = false;
    } else if (isAdding) {
      isAdding = false;
    } else if (showSearch) {
      showSearch = false;
      searchQuery = '';
    } else {
      onback?.();
    }
  };

  onKeybind('back', goBack);

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

  const addContact = async () => {
    if (!newContact.firstname.trim() || !newContact.phone.trim()) {
      toast.show({
        type: 'error',
        message: 'First name and phone number are required.'
      });
      return;
    }
    try {
      await contactsStore.add({
        firstname: newContact.firstname.trim(),
        lastname: newContact.lastname.trim(),
        phone: newContact.phone.trim(),
        avatar: newContact.avatar,
        favorite: newContact.favorite
      });
      isAdding = false;
      newContact = {
        firstname: '',
        lastname: '',
        phone: '',
        avatar: '',
        favorite: false
      };
      toast.show({
        type: 'success',
        message: 'Contact added successfully'
      });
    } catch (e: any) {
      console.error('Failed to create contact', e);
      toast.show({
        type: 'error',
        message: e.message || 'Failed to create contact'
      });
    }
  };

  const updateContact = async () => {
    if (!selectedContact) return;
    if (!selectedContact.firstname.trim() || !selectedContact.phone.trim()) {
      toast.show({
        type: 'error',
        message: 'First name and phone number are required.'
      });
      return;
    }
    try {
      // Sanitize payload to only include updatable fields
      const payload = {
        id: selectedContact.id, // ID is required for update in ServerApp
        firstname: selectedContact.firstname.trim(),
        lastname: selectedContact.lastname ? selectedContact.lastname.trim() : '',
        phone: selectedContact.phone.trim(),
        favorite: selectedContact.favorite,
        avatar: selectedContact.avatar,
        citizenid: selectedContact.citizenid, // Required for type safety
        created_at: selectedContact.created_at,
        updated_at: new Date().toISOString()
      };

      await contactsStore.update(payload);
      isEditing = false;
      toast.show({
        type: 'success',
        message: 'Contact updated successfully'
      });
    } catch (e: any) {
      console.error('Failed to update contact', e);
      toast.show({
        type: 'error',
        message: e.message || 'Failed to update contact'
      });
    }
  };

  const toggleFavorite = async () => {
    if (!selectedContact) return;
    selectedContact.favorite = !selectedContact.favorite;
    await updateContact();
  };

  const deleteContact = async () => {
    if (!selectedContact) return;
    try {
      await contactsStore.delete(selectedContact.id);
      selectedContact = null;
    } catch (e) {
      console.error('Failed to delete contact', e);
    }
  };

  const shareContact = async () => {
    if (!selectedContact) return;
    if (!selectedContact.firstname.trim() || !selectedContact.phone.trim()) {
      toast.show({
        type: 'error',
        message: 'First name and phone number are required to share contact.'
      });
      return;
    }
    try {
      await contactsStore.share({
        name: `${selectedContact.firstname.trim()} ${selectedContact.lastname?.trim() || ''}`.trim(),
        firstname: selectedContact.firstname.trim(),
        lastname: selectedContact.lastname?.trim() || '',
        phone: selectedContact.phone.trim(),
        avatar: selectedContact.avatar || ''
      });
      toast.show({
        type: 'success',
        message: 'Contact shared successfully'
      });
    } catch (e: any) {
      console.error('Failed to share contact', e);
      toast.show({
        type: 'error',
        message: e.message || 'Failed to share contact'
      });
    }
  };

  onAppMount(() => {
    contactsStore.load();
    messagesStore.loadConversations();
  });

  useScrollDetect((v) => (isScrolled = v));

  const getTitle = () => (selectedContact ? 'Contact Details' : 'Contacts');
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

<Screen title={getTitle()} onback={goBack} actions={headerActions} overlay={fabOverlay}>
  {#if !selectedContact}
    {#if isAdding}
      <!-- New Contact Dropdown Panel (Sticky overlay directly below header) -->
      <div
        class="animate-in slide-in-from-top sticky top-0 z-20 space-y-3 border-b border-gray-800 bg-gray-900/95 p-4 shadow-2xl backdrop-blur-md duration-200"
      >
        <div class="flex items-center justify-between border-b border-gray-800 pb-1">
          <h3 class="text-base font-semibold text-white">New Contact</h3>
          <button
            type="button"
            class="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
            onclick={() => (isAdding = false)}
            aria-label="Close form"
          >
            <CloseIcon class="h-5 w-5" />
          </button>
        </div>

        <!-- Avatar Preview & Edit Pencil -->
        <div class="flex justify-center py-2">
          <div class="relative">
            <Avatar
              src={newContact.avatar}
              initials={(newContact.firstname[0] || '') + (newContact.lastname?.[0] || '')}
              size="w-24 h-24"
              textClass="text-3xl"
            />
            <button
              type="button"
              class="absolute right-0 bottom-0 flex items-center justify-center rounded-full border-2 border-gray-900 bg-blue-600 p-2 text-white shadow-lg transition-transform hover:bg-blue-500 active:scale-95"
              onclick={() => openPhotoPicker('new')}
              aria-label="Select photo from gallery"
              title="Select photo from gallery"
            >
              <EditIcon class="h-4 w-4" />
            </button>
          </div>
        </div>

        <input
          class="w-full rounded bg-gray-700 p-2 text-sm text-white placeholder-gray-400"
          placeholder="First Name *"
          bind:value={newContact.firstname}
        />
        <input
          class="w-full rounded bg-gray-700 p-2 text-sm text-white placeholder-gray-400"
          placeholder="Last Name"
          bind:value={newContact.lastname}
        />
        <input
          class="w-full rounded bg-gray-700 p-2 text-sm text-white placeholder-gray-400"
          placeholder="Phone Number *"
          bind:value={newContact.phone}
        />
        <label class="flex items-center space-x-2 text-sm text-gray-300">
          <input
            type="checkbox"
            bind:checked={newContact.favorite}
            class="rounded border-gray-600 bg-gray-700 text-blue-600"
          />
          <span>Favorite</span>
        </label>

        <div class="flex space-x-2 pt-1">
          <Button variant="secondary" class="flex-1 text-xs" onclick={() => (isAdding = false)}>
            Cancel
          </Button>
          <Button
            class="flex-1 text-xs"
            onclick={addContact}
            disabled={!newContact.firstname.trim() || !newContact.phone.trim()}
          >
            Save Contact
          </Button>
        </div>
      </div>
    {/if}

    {#snippet contactItem(contact: Contact)}
      <ListItem onclick={() => (selectedContact = contact)}>
        <div class="mr-4 shrink-0">
          <Avatar
            src={contact.avatar}
            initials={(contact.firstname[0] || '') + (contact.lastname?.[0] || '')}
            bgClass="bg-gray-800 border border-gray-700/60"
          />
        </div>
        <div class="flex min-w-0 flex-1 flex-col">
          <div class="flex items-center">
            <span class="truncate font-medium">
              {contact.firstname}
              {contact.lastname || ''}
            </span>
            {#if contact.favorite}
              <StarIcon class="ml-1.5 h-4 w-4 shrink-0 text-yellow-400" />
            {/if}
          </div>
          <span class="text-xs text-gray-400">{contact.phone}</span>
        </div>
      </ListItem>
    {/snippet}

    {#if showSearch}
      <!-- Search Dropdown Overlay -->
      <div
        class="animate-in slide-in-from-top sticky top-0 z-20 border-b border-gray-800 bg-gray-900/95 p-3 backdrop-blur-md duration-200"
      >
        <SearchBar bind:value={searchQuery} placeholder="Search contacts..." />
      </div>
    {/if}

    <div class="overflow-y-auto">
      {#if filteredFavorites.length > 0}
        <div>
          <div
            class="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/95 px-4 py-1 text-xs font-bold tracking-wider text-gray-400 uppercase backdrop-blur"
          >
            Favorites
          </div>
          <div class="divide-y divide-gray-800">
            {#each filteredFavorites as contact}
              {@render contactItem(contact)}
            {/each}
          </div>
        </div>
      {/if}

      {#if filteredOther.length > 0}
        <div>
          <div
            class="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/95 px-4 py-1 text-xs font-bold tracking-wider text-gray-400 uppercase backdrop-blur"
          >
            Contacts
          </div>
          <div class="divide-y divide-gray-800">
            {#each filteredOther as contact}
              {@render contactItem(contact)}
            {/each}
          </div>
        </div>
      {/if}

      {#if filteredContacts.length === 0}
        <div class="py-16 text-center text-sm text-gray-400">No matching contacts found.</div>
      {/if}
    </div>
  {:else}
    <div
      class="animate-in fade-in slide-in-from-right flex flex-col items-center space-y-6 p-6 duration-300"
    >
      <!-- Avatar & Pencil Overlay -->
      <div class="relative">
        <Avatar
          src={selectedContact.avatar}
          initials={(selectedContact.firstname[0] || '') + (selectedContact.lastname?.[0] || '')}
          size="w-24 h-24"
          textClass="text-4xl"
          bgClass="bg-gray-800 border border-gray-700/60"
        />
        <button
          type="button"
          class="absolute right-0 bottom-0 flex items-center justify-center rounded-full border-2 border-gray-900 bg-blue-600 p-2 text-white shadow-lg transition-transform hover:bg-blue-500 active:scale-95"
          onclick={() => openPhotoPicker('edit')}
          aria-label="Select photo from gallery"
          title="Select photo from gallery"
        >
          <EditIcon class="h-4 w-4" />
        </button>
      </div>

      <!-- Header Info & Favorite Toggle -->
      <div class="flex items-center justify-center space-x-2">
        <h2 class="text-2xl font-bold">
          {selectedContact.firstname}
          {selectedContact.lastname || ''}
        </h2>
        <button
          type="button"
          class="rounded-full p-1 transition-transform hover:scale-110 active:scale-95"
          onclick={toggleFavorite}
          aria-label="Toggle favorite"
          title={selectedContact.favorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <StarIcon
            filled={selectedContact.favorite}
            class={selectedContact.favorite
              ? 'h-6 w-6 text-yellow-400'
              : 'h-6 w-6 text-gray-500 hover:text-yellow-400'}
          />
        </button>
      </div>

      <!-- Actions Row -->
      <div class="flex space-x-4">
        <Button
          variant="icon"
          class="bg-green-600 text-white hover:bg-green-500 hover:text-white"
          onclick={handleCall}
          aria-label="Call"
        >
          <!-- Call Icon -->
          <PhoneIcon />
        </Button>
        <Button
          variant="icon"
          class="bg-blue-600 text-white hover:bg-blue-500 hover:text-white"
          onclick={handleMessage}
          aria-label="Message"
        >
          <!-- Message Icon -->
          <MessageIcon />
        </Button>

        <Button
          variant="icon"
          class="bg-gray-700 text-white hover:bg-gray-600 hover:text-white"
          onclick={shareContact}
          disabled={!selectedContact?.firstname?.trim() || !selectedContact?.phone?.trim()}
          aria-label="Share"
        >
          <!-- Share Icon -->
          <ShareIcon />
        </Button>
        <Button
          variant="icon"
          class="bg-gray-700 text-white hover:bg-gray-600 hover:text-white"
          onclick={() => (isEditing = !isEditing)}
          aria-label="Edit"
        >
          <!-- Edit Icon -->
          <EditIcon />
        </Button>
        <Button
          variant="icon"
          class="bg-red-900/50 text-red-400 hover:bg-red-900/80 hover:text-red-300"
          onclick={deleteContact}
          aria-label="Delete"
        >
          <!-- Trash Icon -->
          <TrashIcon />
        </Button>
      </div>

      <!-- Details List / Edit Form -->
      <div class="w-full space-y-4 rounded-xl bg-gray-800 p-4 shadow-lg">
        {#if isEditing}
          <div class="space-y-3">
            <input
              class="w-full rounded bg-gray-700 p-2"
              bind:value={selectedContact.firstname}
              placeholder="First Name *"
            />
            <input
              class="w-full rounded bg-gray-700 p-2"
              bind:value={selectedContact.lastname}
              placeholder="Last Name"
            />
            <input
              class="w-full rounded bg-gray-700 p-2"
              bind:value={selectedContact.phone}
              placeholder="Phone *"
            />
            <label class="flex items-center space-x-2">
              <input type="checkbox" bind:checked={selectedContact.favorite} />
              <span>Favorite</span>
            </label>
            <Button
              class="w-full"
              onclick={updateContact}
              disabled={!selectedContact.firstname.trim() || !selectedContact.phone.trim()}
            >
              Save Changes
            </Button>
          </div>
        {:else}
          <div class="flex flex-col">
            <span class="text-xs tracking-wider text-gray-400 uppercase">Phone</span>
            <span class="text-lg">{selectedContact.phone}</span>
          </div>
        {/if}
      </div>

      <!-- Recent Text Messages Card -->
      <div
        class="w-full overflow-hidden rounded-xl border border-gray-700/60 bg-gray-800 shadow-lg"
      >
        <div
          class="flex items-center justify-between border-b border-gray-700/60 bg-gray-800/80 px-4 py-3"
        >
          <div class="flex items-center gap-2">
            <MessageIcon class="h-4 w-4 text-blue-400" />
            <h4 class="text-xs font-bold tracking-wider text-gray-300 uppercase">
              Recent Text Messages
            </h4>
          </div>
          {#if matchingConv}
            <button
              type="button"
              class="cursor-pointer text-xs font-semibold text-blue-400 transition-colors hover:text-blue-300"
              onclick={handleMessage}
            >
              View All ({contactMessages.length})
            </button>
          {/if}
        </div>

        {#if recentMessages.length > 0}
          <div class="divide-y divide-gray-700/40">
            {#each recentMessages as msg}
              <button
                type="button"
                class="group flex w-full cursor-pointer items-center justify-between gap-3 p-3.5 text-left transition-colors hover:bg-gray-700/40"
                onclick={handleMessage}
              >
                <div class="min-w-0 flex-1">
                  <div class="mb-1 flex items-center gap-2">
                    <span
                      class="text-xs font-bold {msg.sender === 'me'
                        ? 'text-blue-400'
                        : 'text-gray-200'}"
                    >
                      {msg.sender === 'me' ? 'You' : selectedContact.firstname}
                    </span>
                    <span class="text-[10px] text-gray-500">•</span>
                    <span class="text-[10px] text-gray-400">
                      {formatRelativeTime(msg.created_at)}
                    </span>
                  </div>
                  <p class="truncate text-xs leading-relaxed text-gray-300">
                    {msg.message}
                  </p>
                </div>
                <ChevronRightIcon
                  class="h-4 w-4 shrink-0 text-gray-600 transition-colors group-hover:text-gray-400"
                />
              </button>
            {/each}
          </div>
        {:else}
          <div class="flex flex-col items-center gap-2 p-6 text-center text-xs text-gray-400">
            <MessageIcon class="mb-1 h-8 w-8 text-gray-600" />
            <span>No recent messages with {selectedContact.firstname}.</span>
            <button
              type="button"
              class="mt-1 cursor-pointer rounded-full border border-blue-500/30 bg-blue-600/30 px-3 py-1 text-xs font-medium text-blue-300 transition-all hover:bg-blue-600/50"
              onclick={handleMessage}
            >
              Send Text Message
            </button>
          </div>
        {/if}
      </div>
    </div>
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
