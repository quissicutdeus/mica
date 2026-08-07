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
  class="animate-in slide-in-from-top bg-surface-container border-outline-variant sticky top-0 z-20 space-y-3 border-b p-4 shadow-2xl backdrop-blur-md duration-200"
>
  <div class="border-outline-variant flex items-center justify-between border-b pb-1">
    <h3 class="text-on-surface text-base font-semibold">New Contact</h3>
    <button
      type="button"
      class="text-on-surface-variant hover:bg-surface hover:text-on-surface rounded-full p-1 transition-colors"
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
        class="border-surface bg-primary-container text-on-primary-container absolute right-0 bottom-0 flex items-center justify-center rounded-full border-2 p-2 shadow-lg transition-transform hover:brightness-110 active:scale-95"
        onclick={() => onpickphoto()}
        aria-label="Select photo from gallery"
        title="Select photo from gallery"
      >
        <EditIcon class="h-4 w-4" />
      </button>
    </div>
  </div>

  <input
    class="bg-surface-container-low placeholder-on-surface-variant border-outline-variant text-on-surface w-full rounded border p-2 text-sm"
    placeholder="First Name *"
    maxlength="50"
    bind:value={draft.firstname}
  />
  <input
    class="bg-surface-container-low placeholder-on-surface-variant border-outline-variant text-on-surface w-full rounded border p-2 text-sm"
    placeholder="Last Name"
    maxlength="50"
    bind:value={draft.lastname}
  />
  <input
    class="bg-surface-container-low placeholder-on-surface-variant border-outline-variant text-on-surface w-full rounded border p-2 text-sm"
    placeholder="Phone Number *"
    maxlength="20"
    bind:value={draft.phone}
  />
  <label class="text-on-surface-variant flex items-center space-x-2 text-sm">
    <input
      type="checkbox"
      bind:checked={draft.favorite}
      class="bg-surface-container-low border-outline-variant text-primary rounded"
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
