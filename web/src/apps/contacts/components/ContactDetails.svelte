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
      bgClass="bg-surface-container border border-outline-variant"
    />
    <button
      type="button"
      class="border-surface bg-primary-container text-on-primary-container hover:bg-primary-container-hover absolute right-0 bottom-0 flex items-center justify-center rounded-full border-2 p-2 shadow-lg transition-transform active:scale-95"
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
          : 'text-on-surface-variant h-6 w-6 hover:text-yellow-400'}
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
      class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover hover:text-on-primary"
      onclick={onmessage}
      aria-label="Message"
    >
      <!-- Message Icon -->
      <MessageIcon />
    </Button>

    <Button
      variant="icon"
      class="bg-surface-container-high text-on-surface hover:bg-surface-container-highest hover:text-on-surface"
      onclick={onshare}
      disabled={busy || !contact?.firstname?.trim() || !contact?.phone?.trim()}
      aria-label="Share"
    >
      <!-- Share Icon -->
      <ShareIcon />
    </Button>
    <Button
      variant="icon"
      class="bg-surface-container-high text-on-surface hover:bg-surface-container-highest hover:text-on-surface"
      onclick={() => onedit()}
      aria-label="Edit"
    >
      <!-- Edit Icon -->
      <EditIcon />
    </Button>
    <Button
      variant="icon"
      class="text-error hover:text-error bg-red-900/50 hover:bg-red-900/80"
      onclick={ondelete}
      disabled={busy}
      aria-label="Delete"
    >
      <!-- Trash Icon -->
      <TrashIcon />
    </Button>
  </div>

  <!-- Details List / Edit Form -->
  <div class="bg-surface-container w-full space-y-4 rounded-xl p-4 shadow-lg">
    {#if isEditing}
      <div class="space-y-3">
        <input
          class="bg-surface-container-high w-full rounded p-2"
          maxlength="50"
          bind:value={contact.firstname}
          placeholder="First Name *"
        />
        <input
          class="bg-surface-container-high w-full rounded p-2"
          maxlength="50"
          bind:value={contact.lastname}
          placeholder="Last Name"
        />
        <input
          class="bg-surface-container-high w-full rounded p-2"
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
        <span class="text-on-surface-variant text-xs tracking-wider uppercase">Phone</span>
        <span class="text-lg">{contact.phone}</span>
      </div>
    {/if}
  </div>

  <!-- Recent Text Messages Card -->
  <div
    class="border-outline-variant bg-surface-container w-full overflow-hidden rounded-xl border shadow-lg"
  >
    <div
      class="border-outline-variant bg-surface-container flex items-center justify-between border-b px-4 py-3"
    >
      <div class="flex items-center gap-2">
        <MessageIcon class="text-primary h-4 w-4" />
        <h4 class="text-on-surface text-xs font-bold tracking-wider uppercase">
          Recent Text Messages
        </h4>
      </div>
      {#if messageCount > 0}
        <button
          type="button"
          class="text-primary hover:text-primary cursor-pointer text-xs font-semibold transition-colors"
          onclick={onmessage}
        >
          View All ({messageCount})
        </button>
      {/if}
    </div>

    {#if recentMessages.length > 0}
      <div class="divide-outline-variant divide-y">
        {#each recentMessages as msg}
          <button
            type="button"
            class="group hover:bg-surface-container-high flex w-full cursor-pointer items-center justify-between gap-3 p-3.5 text-left transition-colors"
            onclick={onmessage}
          >
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex items-center gap-2">
                <span
                  class="text-xs font-bold {msg.sender === 'me'
                    ? 'text-primary'
                    : 'text-on-surface'}"
                >
                  {msg.sender === 'me' ? 'You' : contact.firstname}
                </span>
                <span class="text-on-surface-variant text-[10px]">•</span>
                <span class="text-on-surface-variant text-[10px]">
                  {formatRelativeTime(msg.created_at)}
                </span>
              </div>
              <p class="text-on-surface truncate text-xs leading-relaxed">
                {msg.message}
              </p>
            </div>
            <ChevronRightIcon
              class="text-outline group-hover:text-on-surface-variant h-4 w-4 shrink-0 transition-colors"
            />
          </button>
        {/each}
      </div>
    {:else}
      <div class="text-on-surface-variant flex flex-col items-center gap-2 p-6 text-center text-xs">
        <MessageIcon class="text-outline mb-1 h-8 w-8" />
        <span>No recent messages with {contact.firstname}.</span>
        <button
          type="button"
          class="border-primary bg-primary-container text-on-primary-container hover:bg-primary-container-hover mt-1 cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-all"
          onclick={onmessage}
        >
          Send Text Message
        </button>
      </div>
    {/if}
  </div>
</div>
