<script lang="ts">
  import { MediaThumb, useLocation, useAppAction, useContacts, fly } from '@gphone/sdk';
  import type { MediaPreview } from '@shared/types';
  import {
    CloseIcon,
    LocationIcon,
    PaperclipIcon,
    PhotoIcon,
    MessageBar,
    PhotoPickerModal,
    ReplyIcon,
    Avatar,
    type UIMessage,
    type UIConversation
  } from '@gphone/sdk';

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

<!-- The row itself is `MessageBar` (sdk/ui): shared with Blabber's DM composer, which had
     drifted away from it on every visible detail. What stays here is what is genuinely
     Messages' own — the reply preview and attachment tray above the row, the attach button
     before the field, and a send that an attachment alone can enable. -->
<MessageBar
  bind:value={text}
  {busy}
  canSend={!busy && (!!text.trim() || attachments.length > 0)}
  {onsend}
>
  {#snippet above()}
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
              textClass="text-label-small"
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
        {#each attachments as att (att.photo_id)}
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
  {/snippet}

  {#snippet leading()}
    <button
      type="button"
      class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary duration-short ease-standard flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors"
      onclick={() => (showAttachMenu = !showAttachMenu)}
      aria-label="Attachments"
    >
      <PaperclipIcon class="size-icon-md" />
    </button>
  {/snippet}
</MessageBar>

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

{#if showPicker}
  <PhotoPickerModal
    title="Select Photos"
    multiSelect={true}
    selectedIds={attachments.map((a) => a.photo_id)}
    onmultichange={(photoId: number, media: MediaPreview) => {
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
