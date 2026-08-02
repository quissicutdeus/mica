<script lang="ts">
  import {
    CloseIcon,
    LocationIcon,
    PaperclipIcon,
    PhotoIcon,
    PhotoPickerModal,
    SendIcon
  } from '@gphone/sdk';
  import { fly } from 'svelte/transition';

  /**
   * The message input: attachments tray, attach menu, photo picker, send.
   *
   * `text` and `attachments` are bound because the draft belongs to the conversation,
   * not to this row — the app clears both when the thread closes and keeps them when a
   * send fails.
   */
  let {
    text = $bindable(''),
    attachments = $bindable([]),
    busy,
    onsend,
    onopenphotos
  }: {
    text: string;
    attachments: { photo_id: number; image: string }[];
    busy: boolean;
    onsend: () => void;
    onopenphotos: () => void;
  } = $props();

  let showAttachMenu = $state(false);
  let showPicker = $state(false);
</script>

<!-- Input Area -->
<div class="border-t border-gray-700 bg-gray-800/50 p-3 backdrop-blur-md">
  {#if attachments.length > 0}
    <div class="no-scrollbar mb-2 flex gap-2 overflow-x-auto p-1">
      {#each attachments as att}
        <div
          class="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-gray-600 shadow-md"
        >
          <img src={att.image} alt="Attachment" class="h-full w-full object-cover" />
          <button
            class="absolute top-0 right-0 cursor-pointer rounded-bl-lg bg-black/60 p-0.5 text-white hover:bg-black"
            onclick={() => (attachments = attachments.filter((a) => a.photo_id !== att.photo_id))}
            aria-label="Remove attachment"
          >
            <CloseIcon class="h-3 w-3" />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="flex w-full items-center gap-2.5">
    <button
      type="button"
      class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-700/50 hover:text-blue-400"
      onclick={() => (showAttachMenu = !showAttachMenu)}
      aria-label="Attachments"
    >
      <PaperclipIcon class="h-5 w-5" />
    </button>

    <div
      class="flex flex-1 items-center rounded-2xl border border-transparent bg-gray-700/50 px-3.5 py-1.5 text-white focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500"
    >
      <textarea
        class="no-scrollbar h-[22px] max-h-32 min-h-[22px] w-full resize-none bg-transparent p-0 text-sm leading-normal text-white placeholder-gray-400 focus:outline-none"
        placeholder="Message"
        rows="1"
        bind:value={text}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onsend();
          }
        }}></textarea>
    </div>

    <button
      type="button"
      class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-white shadow-md transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
      onclick={onsend}
      disabled={busy || (!text.trim() && attachments.length === 0)}
      aria-label="Send"
    >
      <SendIcon class="h-4 w-4 text-white" />
    </button>
  </div>

  {#if showAttachMenu}
    <div
      class="absolute bottom-16 left-4 grid w-48 grid-cols-2 gap-2 rounded-xl border border-gray-700 bg-gray-800 p-2 shadow-xl"
      transition:fly={{ y: 20, duration: 200 }}
    >
      <button
        class="flex flex-col items-center justify-center rounded-lg p-3 transition-colors hover:bg-gray-700/50"
        onclick={onopenphotos}
      >
        <div
          class="mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-blue-500/20 text-blue-400"
        >
          <PhotoIcon class="h-5 w-5" />
        </div>
        <span class="text-xs">Photo</span>
      </button>
      <button
        class="flex flex-col items-center justify-center rounded-lg p-3 transition-colors hover:bg-gray-700/50"
      >
        <div
          class="mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-green-500/20 text-green-400"
        >
          <LocationIcon class="h-5 w-5" />
        </div>
        <span class="text-xs">Location</span>
      </button>
    </div>
  {/if}
</div>

{#if showPicker}
  <PhotoPickerModal
    title="Select Photos"
    multiSelect={true}
    selectedIds={attachments.map((a) => a.photo_id)}
    onmultichange={(photoId, image) => {
      const existing = attachments.find((a) => a.photo_id === photoId);
      if (existing) {
        attachments = attachments.filter((a) => a.photo_id !== photoId);
      } else {
        attachments = [...attachments, { photo_id: photoId, image }];
      }
    }}
    onclose={() => (showPicker = false)}
  />
{/if}
