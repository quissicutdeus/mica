<script lang="ts">
  import {
    useNavigation,
    useContacts,
    useMessages,
    type UIConversation,
    ArchiveIcon,
    ChevronRightIcon,
    CloseIcon,
    StarIcon,
    TrashIcon,
    Avatar,
    Button
  } from '@gphone/sdk';

  const { openApp } = useNavigation();
  const { contactsStore: contacts } = useContacts();
  const { messagesStore } = useMessages();

  interface Props {
    currentConv: UIConversation;
    onclose: () => void;
    ondelete: () => void;
  }

  let { currentConv, onclose, ondelete }: Props = $props();

  let editNameValue = $state('');

  $effect(() => {
    if (currentConv) {
      editNameValue = currentConv.targetName;
    }
  });

  const handleSaveGroupName = async () => {
    if (editNameValue.trim() && currentConv) {
      await messagesStore.renameConversation(currentConv.id, editNameValue.trim());
    }
  };
</script>

<div
  class="animate-in fade-in absolute inset-0 z-40 flex flex-col bg-gray-950/95 backdrop-blur-md duration-200"
>
  <!-- Modal Header -->
  <div class="flex items-center justify-between border-b border-gray-800 p-4">
    <h3 class="text-base font-semibold text-white">Conversation Details</h3>
    <button
      type="button"
      class="cursor-pointer rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
      onclick={onclose}
      aria-label="Close details"
    >
      <CloseIcon class="h-5 w-5" />
    </button>
  </div>

  <div class="no-scrollbar flex-1 space-y-5 overflow-y-auto p-4">
    <!-- Header Avatar & Name Info -->
    <div class="flex flex-col items-center space-y-2 py-2 text-center">
      <Avatar
        src={currentConv.targetAvatar}
        initials={currentConv.targetName ? currentConv.targetName[0] : '?'}
        size="w-20 h-20"
        textClass="text-2xl font-bold"
        bgClass={currentConv.is_group ? 'bg-indigo-700' : 'bg-gray-800 border border-gray-700'}
      />
      <div>
        <div class="flex items-center justify-center gap-1.5">
          <h2 class="text-lg font-bold text-white">
            {currentConv.targetName}
          </h2>
          {#if !currentConv.is_group}
            {@const targetContact = $contacts.find(
              (c) => c.phone === currentConv.target || c.citizenid === currentConv.target
            )}
            {#if targetContact?.favorite}
              <StarIcon filled={true} class="h-5 w-5 shrink-0 text-yellow-400" />
            {/if}
          {/if}
        </div>
        <p class="text-xs text-gray-400">
          {currentConv.is_group ? 'Group Conversation' : currentConv.target}
        </p>
      </div>
    </div>

    <!-- Group Rename & Participants Section -->
    {#if currentConv.is_group}
      <div class="space-y-2 rounded-xl border border-gray-800 bg-gray-900/80 p-3">
        <label for="group-name-input" class="text-xs font-semibold text-gray-300">Group Name</label>
        <div class="flex gap-2">
          <input
            id="group-name-input"
            type="text"
            bind:value={editNameValue}
            class="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
            placeholder="Enter group name"
          />
          <Button class="shrink-0 px-3 py-1.5 text-xs" onclick={handleSaveGroupName}>Save</Button>
        </div>
      </div>

      <!-- Group Participants Section -->
      <div class="space-y-2">
        <h4 class="px-1 text-xs font-bold tracking-wider text-gray-400 uppercase">
          Group Members ({currentConv.participants?.length || 0})
        </h4>
        <div
          class="divide-y divide-gray-700/50 overflow-hidden rounded-xl border border-gray-700/60 bg-gray-800/80 shadow-lg"
        >
          {#each currentConv.participants || [] as member}
            {@const pContact =
              member.contact || $contacts.find((c) => c.citizenid === member.citizenid)}
            <button
              type="button"
              class="group flex w-full cursor-pointer items-center justify-between p-3 text-left transition-colors hover:bg-gray-700/50"
              onclick={() => {
                onclose();
                if (pContact) {
                  openApp('contacts', {
                    initialContact: pContact
                  });
                }
              }}
            >
              <div class="flex items-center gap-3">
                <Avatar
                  src={pContact?.avatar}
                  initials={pContact ? pContact.firstname[0] : 'M'}
                  size="w-8 h-8"
                  textClass="text-xs"
                  bgClass="bg-gray-800 border border-gray-700/60"
                />
                <div>
                  <p
                    class="text-xs font-semibold text-gray-200 transition-colors group-hover:text-white"
                  >
                    {pContact
                      ? `${pContact.firstname} ${pContact.lastname || ''}`.trim()
                      : member.citizenid}
                  </p>
                  {#if pContact?.phone}
                    <p class="text-[10px] text-gray-400">
                      {pContact.phone}
                    </p>
                  {/if}
                </div>
              </div>
              <ChevronRightIcon
                class="h-4 w-4 text-gray-500 transition-colors group-hover:text-gray-300"
              />
            </button>
          {/each}
          {#if !currentConv.participants || currentConv.participants.length === 0}
            <div class="p-3 text-center text-xs text-gray-500">No member details available.</div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Conversation Actions (Archive & Delete) -->
    <div class="space-y-2 pt-2">
      <Button
        variant="secondary"
        class="flex w-full items-center justify-center gap-2 py-2.5 text-xs"
        onclick={async () => {
          if (currentConv) {
            const isArchived = currentConv.status === 'archived';
            await messagesStore.archiveConversation(currentConv.id, !isArchived);
            onclose();
          }
        }}
      >
        <ArchiveIcon class="h-4 w-4" />
        {currentConv?.status === 'archived' ? 'Unarchive Conversation' : 'Archive Conversation'}
      </Button>

      <Button
        variant="danger"
        class="flex w-full items-center justify-center gap-2 py-2.5 text-xs"
        onclick={async () => {
          if (currentConv) {
            await messagesStore.deleteConversation(currentConv.id);
            ondelete();
          }
        }}
      >
        <TrashIcon class="h-4 w-4" />
        Delete Conversation
      </Button>
    </div>
  </div>
</div>
