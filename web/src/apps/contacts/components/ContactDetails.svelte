<script lang="ts">
  import {
    Avatar,
    Button,
    ChevronRightIcon,
    EditIcon,
    MessageIcon,
    PhoneIcon,
    ShareIcon,
    StarIcon,
    TrashIcon,
    formatRelativeTime,
    type Contact,
    type UIMessage
  } from '@gphone/sdk';

  /**
   * One contact: the header, the action row, and either the details or the edit form.
   *
   * `contact` is the parent's `$state` object rather than a copy, so the edit form can
   * bind straight to it — which is what the parent's optimistic favourite toggle and its
   * rollback both rely on.
   */
  let {
    contact,
    isEditing,
    busy,
    recentMessages,
    messageCount,
    oncall,
    onmessage,
    onshare,
    ondelete,
    onsave,
    ontogglefavorite,
    onpickphoto,
    onedit
  }: {
    contact: Contact;
    isEditing: boolean;
    busy: boolean;
    recentMessages: UIMessage[];
    /** The whole thread, not just the five shown. Zero means no conversation exists. */
    messageCount: number;
    oncall: () => void;
    onmessage: () => void;
    onshare: () => void;
    ondelete: () => void;
    onsave: () => void;
    ontogglefavorite: () => void;
    onpickphoto: () => void;
    onedit: () => void;
  } = $props();
</script>

<div
  class="animate-in fade-in slide-in-from-right flex flex-col items-center space-y-6 p-6 duration-300"
>
  <!-- Avatar & Pencil Overlay -->
  <div class="relative">
    <Avatar
      src={contact.avatar}
      initials={(contact.firstname[0] || '') + (contact.lastname?.[0] || '')}
      size="w-24 h-24"
      textClass="text-4xl"
      bgClass="bg-gray-800 border border-gray-700/60"
    />
    <button
      type="button"
      class="absolute right-0 bottom-0 flex items-center justify-center rounded-full border-2 border-gray-900 bg-blue-600 p-2 text-white shadow-lg transition-transform hover:bg-blue-500 active:scale-95"
      onclick={() => onpickphoto()}
      aria-label="Select photo from gallery"
      title="Select photo from gallery"
    >
      <EditIcon class="h-4 w-4" />
    </button>
  </div>

  <!-- Header Info & Favorite Toggle -->
  <div class="flex items-center justify-center space-x-2">
    <h2 class="text-2xl font-bold">
      {contact.firstname}
      {contact.lastname || ''}
    </h2>
    <button
      type="button"
      class="rounded-full p-1 transition-transform hover:scale-110 active:scale-95"
      onclick={ontogglefavorite}
      aria-label="Toggle favorite"
      title={contact.favorite ? 'Remove from favorites' : 'Add to favorites'}
    >
      <StarIcon
        filled={contact.favorite}
        class={contact.favorite
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
      onclick={oncall}
      aria-label="Call"
    >
      <!-- Call Icon -->
      <PhoneIcon />
    </Button>
    <Button
      variant="icon"
      class="bg-blue-600 text-white hover:bg-blue-500 hover:text-white"
      onclick={onmessage}
      aria-label="Message"
    >
      <!-- Message Icon -->
      <MessageIcon />
    </Button>

    <Button
      variant="icon"
      class="bg-gray-700 text-white hover:bg-gray-600 hover:text-white"
      onclick={onshare}
      disabled={busy || !contact?.firstname?.trim() || !contact?.phone?.trim()}
      aria-label="Share"
    >
      <!-- Share Icon -->
      <ShareIcon />
    </Button>
    <Button
      variant="icon"
      class="bg-gray-700 text-white hover:bg-gray-600 hover:text-white"
      onclick={() => onedit()}
      aria-label="Edit"
    >
      <!-- Edit Icon -->
      <EditIcon />
    </Button>
    <Button
      variant="icon"
      class="bg-red-900/50 text-red-400 hover:bg-red-900/80 hover:text-red-300"
      onclick={ondelete}
      disabled={busy}
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
          maxlength="50"
          bind:value={contact.firstname}
          placeholder="First Name *"
        />
        <input
          class="w-full rounded bg-gray-700 p-2"
          maxlength="50"
          bind:value={contact.lastname}
          placeholder="Last Name"
        />
        <input
          class="w-full rounded bg-gray-700 p-2"
          bind:value={contact.phone}
          placeholder="Phone *"
        />
        <label class="flex items-center space-x-2">
          <input type="checkbox" bind:checked={contact.favorite} />
          <span>Favorite</span>
        </label>
        <Button
          class="w-full"
          onclick={onsave}
          disabled={busy || !contact.firstname.trim() || !contact.phone.trim()}
        >
          {busy ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    {:else}
      <div class="flex flex-col">
        <span class="text-xs tracking-wider text-gray-400 uppercase">Phone</span>
        <span class="text-lg">{contact.phone}</span>
      </div>
    {/if}
  </div>

  <!-- Recent Text Messages Card -->
  <div class="w-full overflow-hidden rounded-xl border border-gray-700/60 bg-gray-800 shadow-lg">
    <div
      class="flex items-center justify-between border-b border-gray-700/60 bg-gray-800/80 px-4 py-3"
    >
      <div class="flex items-center gap-2">
        <MessageIcon class="h-4 w-4 text-blue-400" />
        <h4 class="text-xs font-bold tracking-wider text-gray-300 uppercase">
          Recent Text Messages
        </h4>
      </div>
      {#if messageCount > 0}
        <button
          type="button"
          class="cursor-pointer text-xs font-semibold text-blue-400 transition-colors hover:text-blue-300"
          onclick={onmessage}
        >
          View All ({messageCount})
        </button>
      {/if}
    </div>

    {#if recentMessages.length > 0}
      <div class="divide-y divide-gray-700/40">
        {#each recentMessages as msg}
          <button
            type="button"
            class="group flex w-full cursor-pointer items-center justify-between gap-3 p-3.5 text-left transition-colors hover:bg-gray-700/40"
            onclick={onmessage}
          >
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex items-center gap-2">
                <span
                  class="text-xs font-bold {msg.sender === 'me'
                    ? 'text-blue-400'
                    : 'text-gray-200'}"
                >
                  {msg.sender === 'me' ? 'You' : contact.firstname}
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
        <span>No recent messages with {contact.firstname}.</span>
        <button
          type="button"
          class="mt-1 cursor-pointer rounded-full border border-blue-500/30 bg-blue-600/30 px-3 py-1 text-xs font-medium text-blue-300 transition-all hover:bg-blue-600/50"
          onclick={onmessage}
        >
          Send Text Message
        </button>
      </div>
    {/if}
  </div>
</div>
