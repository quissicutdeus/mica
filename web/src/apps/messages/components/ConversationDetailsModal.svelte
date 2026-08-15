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
  const { conversationsStore } = useMessages();

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
      await conversationsStore.renameConversation(currentConv.id, editNameValue.trim());
    }
  };
</script>

<div
  class="animate-in fade-in bg-surface-container-lowest duration-medium ease-emphasized absolute inset-0 z-40 flex flex-col backdrop-blur-md"
>
  <!-- Modal Header -->
  <div class="border-outline-variant flex items-center justify-between border-b p-4">
    <h3 class="text-on-surface text-body-large">Conversation Details</h3>
    <button
      type="button"
      class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard cursor-pointer rounded-full p-1 transition-colors"
      onclick={onclose}
      aria-label="Close details"
    >
      <CloseIcon class="size-icon-md" />
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
        bgClass={currentConv.is_group
          ? 'bg-indigo-700'
          : 'bg-surface-container border border-outline-variant'}
      />
      <div>
        <div class="flex items-center justify-center gap-1.5">
          <h2 class="text-on-surface text-lg font-bold">
            {currentConv.targetName}
          </h2>
          {#if !currentConv.is_group}
            {@const targetContact = $contacts.find(
              (c) => c.phone === currentConv.target || c.citizenid === currentConv.target
            )}
            {#if targetContact?.favorite}
              <StarIcon filled={true} class="size-icon-md shrink-0 text-yellow-400" />
            {/if}
          {/if}
        </div>
        <p class="text-on-surface-variant text-body-small">
          {currentConv.is_group ? 'Group Conversation' : currentConv.target}
        </p>
      </div>
    </div>

    <!-- Group Rename & Participants Section -->
    {#if currentConv.is_group}
      <div class="border-outline-variant bg-surface space-y-2 rounded-xl border p-3">
        <label for="group-name-input" class="text-on-surface text-body-small">Group Name</label>
        <div class="flex gap-2">
          <input
            id="group-name-input"
            type="text"
            maxlength="50"
            bind:value={editNameValue}
            class="border-outline-variant bg-surface-container text-on-surface focus:border-focus-ring text-body-small flex-1 rounded-lg border px-3 py-1.5 focus:outline-none"
            placeholder="Enter group name"
          />
          <Button class="text-body-small shrink-0 px-3 py-1.5" onclick={handleSaveGroupName}
            >Save</Button
          >
        </div>
      </div>

      <!-- Group Participants Section -->
      <div class="space-y-2">
        <h4 class="text-on-surface-variant text-body-small px-1 tracking-wider uppercase">
          Group Members ({currentConv.participants?.length || 0})
        </h4>
        <div
          class="divide-outline-variant border-outline-variant bg-surface-container shadow-elevation-3 divide-y overflow-hidden rounded-xl border"
        >
          {#each currentConv.participants || [] as member}
            {@const pContact =
              member.contact || $contacts.find((c) => c.citizenid === member.citizenid)}
            <button
              type="button"
              class="group hover:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-3 text-left transition-colors"
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
                  bgClass="bg-surface-container border border-outline-variant"
                />
                <div>
                  <p
                    class="text-on-surface group-hover:text-on-surface duration-short ease-standard text-body-small transition-colors"
                  >
                    {pContact
                      ? `${pContact.firstname} ${pContact.lastname || ''}`.trim()
                      : member.citizenid}
                  </p>
                  {#if pContact?.phone}
                    <p class="text-on-surface-variant text-[10px]">
                      {pContact.phone}
                    </p>
                  {/if}
                </div>
              </div>
              <ChevronRightIcon
                class="text-on-surface-variant group-hover:text-on-surface duration-short ease-standard size-icon-sm transition-colors"
              />
            </button>
          {/each}
          {#if !currentConv.participants || currentConv.participants.length === 0}
            <div class="text-on-surface-variant text-body-small p-3 text-center">
              No member details available.
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Conversation Actions (Archive & Delete) -->
    <div class="space-y-2 pt-2">
      <Button
        variant="secondary"
        class="text-body-small flex w-full items-center justify-center gap-2 py-2.5"
        onclick={async () => {
          if (currentConv) {
            const isArchived = currentConv.status === 'archived';
            await conversationsStore.archiveConversation(currentConv.id, !isArchived);
            onclose();
          }
        }}
      >
        <ArchiveIcon class="size-icon-sm" />
        {currentConv?.status === 'archived' ? 'Unarchive Conversation' : 'Archive Conversation'}
      </Button>

      <Button
        variant="danger"
        class="text-body-small flex w-full items-center justify-center gap-2 py-2.5"
        onclick={async () => {
          if (currentConv) {
            await conversationsStore.deleteConversation(currentConv.id);
            ondelete();
          }
        }}
      >
        <TrashIcon class="size-icon-sm" />
        Delete Conversation
      </Button>
    </div>
  </div>
</div>
