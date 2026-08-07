<script lang="ts">
  import { MediaThumb } from '@gphone/sdk';
  import type { MediaPreview } from '@shared/types';
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
    attachments: { photo_id: number; media: MediaPreview }[];
    busy: boolean;
    onsend: () => void;
    onopenphotos: () => void;
  } = $props();

  let showAttachMenu = $state(false);
  let showPicker = $state(false);
</script>

<!-- Input Area -->
<div class="border-outline-variant bg-surface-container border-t p-3 backdrop-blur-md">
  {#if attachments.length > 0}
    <div class="no-scrollbar mb-2 flex gap-2 overflow-x-auto p-1">
      {#each attachments as att}
        <div
          class="border-outline relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border shadow-md"
        >
          <MediaThumb item={att.media} alt="Attachment" />
          <button
            class="text-on-surface absolute top-0 right-0 cursor-pointer rounded-bl-lg bg-black/60 p-0.5 hover:bg-black"
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
      class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors"
      onclick={() => (showAttachMenu = !showAttachMenu)}
      aria-label="Attachments"
    >
      <PaperclipIcon class="h-5 w-5" />
    </button>

    <div
      class="bg-surface-container-high text-on-surface focus-within:border-primary focus-within:ring-primary flex flex-1 items-center rounded-2xl border border-transparent px-3.5 py-1.5 focus-within:ring-1"
    >
      <textarea
        class="no-scrollbar text-on-surface placeholder-on-surface-variant h-[22px] max-h-32 min-h-[22px] w-full resize-none bg-transparent p-0 text-sm leading-normal focus:outline-none"
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
      class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full shadow-md transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      onclick={onsend}
      disabled={busy || (!text.trim() && attachments.length === 0)}
      aria-label="Send"
    >
      <SendIcon class="text-on-surface h-4 w-4" />
    </button>
  </div>

  {#if showAttachMenu}
    <div
      class="border-outline-variant bg-surface-container absolute bottom-16 left-4 grid w-48 grid-cols-2 gap-2 rounded-xl border p-2 shadow-xl"
      transition:fly={{ y: 20, duration: 200 }}
    >
      <button
        class="hover:bg-surface-container-high flex flex-col items-center justify-center rounded-lg p-3 transition-colors"
        onclick={onopenphotos}
      >
        <div
          class="bg-primary-container text-on-primary-container mb-1 flex h-8 w-8 items-center justify-center rounded-full"
        >
          <PhotoIcon class="h-5 w-5" />
        </div>
        <span class="text-xs">Photo</span>
      </button>
      <button
        class="hover:bg-surface-container-high flex flex-col items-center justify-center rounded-lg p-3 transition-colors"
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
    onmultichange={(photoId, media) => {
      const existing = attachments.find((a) => a.photo_id === photoId);
      if (existing) {
        attachments = attachments.filter((a) => a.photo_id !== photoId);
      } else {
        attachments = [...attachments, { photo_id: photoId, media }];
      }
    }}
    onclose={() => (showPicker = false)}
  />
{/if}
