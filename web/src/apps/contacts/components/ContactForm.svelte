<script lang="ts">
  import { Avatar, Button, CloseIcon, EditIcon } from '@gphone/sdk';

  /**
   * The new-contact panel, which slides down under the header rather than taking over
   * the screen — so the list stays visible behind it and Back closes the panel first.
   *
   * `draft` is the parent's `$state` object, mutated in place: Svelte 5 proxies reach
   * through a prop, so `bind:value` here writes to the same object the parent clears
   * once the write lands.
   */
  let {
    draft,
    busy,
    onsave,
    oncancel,
    onpickphoto
  }: {
    draft: {
      firstname: string;
      lastname: string;
      phone: string;
      avatar: string;
      favorite: boolean;
    };
    busy: boolean;
    onsave: () => void;
    oncancel: () => void;
    onpickphoto: () => void;
  } = $props();
</script>

<div
  class="animate-in slide-in-from-top sticky top-0 z-20 space-y-3 border-b border-gray-800 bg-gray-900/95 p-4 shadow-2xl backdrop-blur-md duration-200"
>
  <div class="flex items-center justify-between border-b border-gray-800 pb-1">
    <h3 class="text-base font-semibold text-white">New Contact</h3>
    <button
      type="button"
      class="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
      onclick={() => oncancel()}
      aria-label="Close form"
    >
      <CloseIcon class="h-5 w-5" />
    </button>
  </div>

  <!-- Avatar Preview & Edit Pencil -->
  <div class="flex justify-center py-2">
    <div class="relative">
      <Avatar
        src={draft.avatar}
        initials={(draft.firstname[0] || '') + (draft.lastname?.[0] || '')}
        size="w-24 h-24"
        textClass="text-3xl"
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
  </div>

  <input
    class="w-full rounded bg-gray-700 p-2 text-sm text-white placeholder-gray-400"
    placeholder="First Name *"
    bind:value={draft.firstname}
  />
  <input
    class="w-full rounded bg-gray-700 p-2 text-sm text-white placeholder-gray-400"
    placeholder="Last Name"
    bind:value={draft.lastname}
  />
  <input
    class="w-full rounded bg-gray-700 p-2 text-sm text-white placeholder-gray-400"
    placeholder="Phone Number *"
    bind:value={draft.phone}
  />
  <label class="flex items-center space-x-2 text-sm text-gray-300">
    <input
      type="checkbox"
      bind:checked={draft.favorite}
      class="rounded border-gray-600 bg-gray-700 text-blue-600"
    />
    <span>Favorite</span>
  </label>

  <div class="flex space-x-2 pt-1">
    <Button variant="secondary" class="flex-1 text-xs" onclick={() => oncancel()}>Cancel</Button>
    <Button
      class="flex-1 text-xs"
      onclick={onsave}
      disabled={busy || !draft.firstname.trim() || !draft.phone.trim()}
    >
      {busy ? 'Saving...' : 'Save Contact'}
    </Button>
  </div>
</div>
