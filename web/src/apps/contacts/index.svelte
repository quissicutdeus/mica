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
            disabled={$busy || !newContact.firstname.trim() || !newContact.phone.trim()}
          >
            {$busy ? 'Saving...' : 'Save Contact'}
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

      {#if !$contactsLoaded}
        <div class="p-3">
          <Skeleton count={6} height="h-14" />
        </div>
      {:else if filteredContacts.length === 0}
        <div class="py-16 text-center text-sm text-gray-400">
          {searchQuery.trim() ? 'No matching contacts found.' : 'No contacts yet.'}
        </div>
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
          disabled={$busy || !selectedContact?.firstname?.trim() || !selectedContact?.phone?.trim()}
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
          disabled={$busy}
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
              disabled={$busy || !selectedContact.firstname.trim() || !selectedContact.phone.trim()}
            >
              {$busy ? 'Saving...' : 'Save Changes'}
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
