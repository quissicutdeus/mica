<script lang="ts">
  import { MediaThumb, useLocation, useAppAction, useContacts } from '@gphone/sdk';
  import type { MediaPreview } from '@shared/types';
  import {
    CloseIcon,
    LocationIcon,
    PaperclipIcon,
    PhotoIcon,
    PhotoPickerModal,
    SendIcon,
    ReplyIcon,
    Avatar,
    type UIMessage,
    type UIConversation
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
    replyingTo = null,
    currentConv = null,
    busy,
    onsend,
    onopenphotos,
    oncancelreply
  }: {
    text: string;
    attachments: { photo_id: number; media: MediaPreview }[];
    replyingTo?: UIMessage | null;
    currentConv?: UIConversation | null;
    busy: boolean;
    onsend: () => void;
    onopenphotos: () => void;
    oncancelreply?: () => void;
  } = $props();

  let showAttachMenu = $state(false);
  let showPicker = $state(false);

  const { shareLocation } = useLocation();
  const { run } = useAppAction('messages');
  const { contactsStore: contacts } = useContacts();

  const getSenderInfo = (targetMsg: UIMessage) => {
    if (targetMsg.sender === 'me') {
      return { name: 'You', avatar: undefined };
    }
    if (!currentConv) return { name: 'Member', avatar: undefined };
    const p = currentConv.participants?.find((part) => part.citizenid === targetMsg.citizenid);
    const contact = p?.contact || $contacts.find((c) => c.citizenid === targetMsg.citizenid);
    const name = contact
      ? `${contact.firstname} ${contact.lastname || ''}`.trim()
      : p?.citizenid || 'Member';
    const avatar = contact?.avatar;
    return { name, avatar };
  };

  const handleShareLocation = async () => {
    await run(
      async () => {
        const { id, media } = await shareLocation();
        attachments = [...attachments, { photo_id: id, media }];
      },
      { error: 'Could not share your location' }
    );
    showAttachMenu = false;
  };
</script>

<!-- Input Area -->
<div class="border-outline-variant bg-surface-container border-t p-3 backdrop-blur-md">
  {#if replyingTo}
    {@const replySender = getSenderInfo(replyingTo)}
    <div
      class="bg-surface-container-high border-primary shadow-elevation-1 text-body-small mb-2 flex items-center justify-between rounded-xl border-l-4 p-2"
      transition:fly={{ y: 10, duration: 150 }}
    >
      <div class="flex min-w-0 flex-1 flex-col pr-2">
        <div class="text-primary flex items-center gap-1.5 font-semibold">
          <ReplyIcon class="h-3.5 w-3.5 shrink-0" />
          <Avatar
            src={replySender.avatar}
            initials={replySender.name[0] || '?'}
            size="w-3.5 h-3.5"
            textClass="text-[8px]"
          />
          <span class="text-label-small truncate">Replying to {replySender.name}</span>
        </div>
        <p class="text-on-surface-variant text-label-small mt-0.5 truncate">
          {replyingTo.message || (replyingTo.attachments?.length ? '[Attachment]' : '')}
        </p>
      </div>
      <button
        type="button"
        class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard shrink-0 cursor-pointer rounded-full p-1 transition-colors"
        onclick={oncancelreply}
        aria-label="Cancel reply"
        title="Cancel reply"
      >
        <CloseIcon class="size-icon-sm" />
      </button>
    </div>
  {/if}
  {#if attachments.length > 0}
    <div class="no-scrollbar mb-2 flex gap-2 overflow-x-auto p-1">
      {#each attachments as att}
        <div
          class="border-outline shadow-elevation-2 relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border"
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
      class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary duration-short ease-standard flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors"
      onclick={() => (showAttachMenu = !showAttachMenu)}
      aria-label="Attachments"
    >
      <PaperclipIcon class="size-icon-md" />
    </button>

    <div
      class="bg-surface-container-high text-on-surface focus-within:border-focus-ring focus-within:ring-focus-ring flex flex-1 items-center rounded-lg border border-transparent px-3.5 py-1.5 focus-within:ring-1"
    >
      <textarea
        class="no-scrollbar text-on-surface placeholder-on-surface-variant text-body-medium h-[22px] max-h-32 min-h-[22px] w-full resize-none bg-transparent p-0 leading-normal focus:outline-none"
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
      class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover shadow-elevation-2 duration-short ease-standard flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      onclick={onsend}
      disabled={busy || (!text.trim() && attachments.length === 0)}
      aria-label="Send"
    >
      <SendIcon class="text-on-surface size-icon-sm" />
    </button>
  </div>

  {#if showAttachMenu}
    <div
      class="border-outline-variant bg-surface-container shadow-elevation-4 absolute bottom-16 left-4 grid w-48 grid-cols-2 gap-2 rounded-xl border p-2"
      transition:fly={{ y: 20, duration: 200 }}
    >
      <button
        class="hover:bg-surface-container-high duration-short ease-standard flex flex-col items-center justify-center rounded-lg p-3 transition-colors"
        onclick={onopenphotos}
      >
        <div
          class="bg-primary-container text-on-primary-container mb-1 flex h-8 w-8 items-center justify-center rounded-full"
        >
          <PhotoIcon class="size-icon-md" />
        </div>
        <span class="text-body-small">Photo</span>
      </button>
      <button
        class="hover:bg-surface-container-high duration-short ease-standard flex flex-col items-center justify-center rounded-lg p-3 transition-colors"
        onclick={handleShareLocation}
      >
        <div
          class="mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-green-500/20 text-green-400"
        >
          <LocationIcon class="size-icon-md" />
        </div>
        <span class="text-body-small">Location</span>
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
