<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { MAX_ATTACHMENTS } from '@mica/shared/attachments';
  import { MediaThumb, useLocation, useAppAction, useContacts, useLocale, fly } from '@mica/sdk';
  import type { MediaPreview } from '@mica/shared/types';
  import {
    CloseIcon,
    EditIcon,
    LocationIcon,
    PaperclipIcon,
    PhotoIcon,
    MessageBar,
    PhotoPickerModal,
    ReplyIcon,
    Avatar,
    type UIMessage,
    type UIConversation
  } from '@mica/sdk';

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
    editing = null,
    currentConv = null,
    busy,
    onsend,
    onopenphotos,
    oncancelreply,
    oncanceledit
  }: {
    text: string;
    attachments: { photo_id: number; media: MediaPreview }[];
    replyingTo?: UIMessage | null;
    /**
     * The message being rewritten, if any.
     *
     * Editing happens in this row rather than inside the bubble: the bubble is itself a
     * `<button>` (tapping it reveals the actions), and a textarea nested inside a button is
     * invalid and unfocusable in places. It also means an edit gets the same growing
     * textarea, the same Enter-to-submit and the same home-indicator clearance a new
     * message does, for free.
     */
    editing?: UIMessage | null;
    currentConv?: UIConversation | null;
    busy: boolean;
    onsend: () => void;
    onopenphotos: () => void;
    oncancelreply?: () => void;
    oncanceledit?: () => void;
  } = $props();

  let showAttachMenu = $state(false);
  let showPicker = $state(false);

  const { shareLocation } = useLocation();
  const { run } = useAppAction('messages');
  const { contactsStore: contacts } = useContacts();
  const { t } = useLocale();

  const getSenderInfo = (targetMsg: UIMessage) => {
    if (targetMsg.sender === 'me') {
      return { name: $t('messages.you'), avatar: undefined };
    }
    if (!currentConv) return { name: $t('messages.member'), avatar: undefined };
    const p = currentConv.participants?.find((part) => part.citizenid === targetMsg.citizenid);
    const contact = p?.contact || $contacts.find((c) => c.citizenid === targetMsg.citizenid);
    const name = contact
      ? `${contact.firstname} ${contact.lastname || ''}`.trim()
      : p?.citizenid || $t('messages.member');
    const avatar = contact?.avatar;
    return { name, avatar };
  };

  const handleShareLocation = async () => {
    await run(
      async () => {
        const { id, media } = await shareLocation();
        attachments = [...attachments, { photo_id: id, media }];
      },
      { error: $t('messages.shareLocationFailed') }
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
  placeholder={editing ? $t('messages.editMessage') : $t('messages.messagePlaceholder')}
  canSend={!busy && (editing ? !!text.trim() : !!text.trim() || attachments.length > 0)}
  {onsend}
>
  {#snippet above()}
    <!-- An edit is not a reply and not a new message, so it says which it is. Without the
         banner the only difference between rewriting a message and sending a new one is
         that the box already had words in it. -->
    {#if editing}
      <div
        class="bg-surface-container-high border-primary shadow-elevation-1 text-body-small mb-2 flex items-center justify-between rounded-box border-l-4 p-2"
        transition:fly={{ y: 10, duration: 150 }}
      >
        <div class="flex min-w-0 flex-1 flex-col pr-2">
          <div class="text-primary flex items-center gap-1.5 font-semibold">
            <EditIcon class="h-3.5 w-3.5 shrink-0" />
            <span class="text-label-small truncate">{$t('messages.editingMessage')}</span>
          </div>
          <p class="text-on-surface-variant text-label-small mt-0.5 truncate">
            {$t('messages.editingHint')}
          </p>
        </div>
        <button
          type="button"
          class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard shrink-0 cursor-pointer rounded-full p-1 transition-colors"
          onclick={oncanceledit}
          aria-label={$t('messages.cancelEdit')}
          title={$t('messages.cancelEdit')}
        >
          <CloseIcon class="size-icon-sm" />
        </button>
      </div>
    {/if}
    {#if replyingTo}
      {@const replySender = getSenderInfo(replyingTo)}
      <div
        class="bg-surface-container-high border-primary shadow-elevation-1 text-body-small mb-2 flex items-center justify-between rounded-box border-l-4 p-2"
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
            <span class="text-label-small truncate"
              >{$t('messages.replyingTo', { name: replySender.name })}</span
            >
          </div>
          <p class="text-on-surface-variant text-label-small mt-0.5 truncate">
            {replyingTo.message ||
              (replyingTo.attachments?.length ? $t('messages.attachmentTag') : '')}
          </p>
        </div>
        <button
          type="button"
          class="text-on-surface-variant hover:bg-surface-container hover:text-on-surface duration-short ease-standard shrink-0 cursor-pointer rounded-full p-1 transition-colors"
          onclick={oncancelreply}
          aria-label={$t('messages.cancelReply')}
          title={$t('messages.cancelReply')}
        >
          <CloseIcon class="size-icon-sm" />
        </button>
      </div>
    {/if}
    {#if attachments.length > 0}
      <div class="no-scrollbar mb-2 flex gap-2 overflow-x-auto p-1">
        {#each attachments as att (att.photo_id)}
          <div
            class="border-outline shadow-elevation-2 relative h-12 w-12 shrink-0 overflow-hidden rounded-box border"
          >
            <MediaThumb item={att.media} alt={$t('messages.attachment')} />
            <button
              class="text-on-surface absolute top-0 right-0 cursor-pointer rounded-bl-lg bg-black/60 p-0.5 hover:bg-black"
              onclick={() => (attachments = attachments.filter((a) => a.photo_id !== att.photo_id))}
              aria-label={$t('messages.removeAttachment')}
            >
              <CloseIcon class="h-3 w-3" />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/snippet}

  {#snippet leading()}
    <!-- Hidden while editing. An edit rewrites the body and nothing else — the server's
         `edit` action takes `message` alone — so offering the attach menu here would be a
         button that appears to work and changes nothing. -->
    {#if !editing}
      <button
        type="button"
        class="text-on-surface-variant hover:bg-surface-container-high hover:text-primary duration-short ease-standard flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors"
        onclick={() => (showAttachMenu = !showAttachMenu)}
        aria-label={$t('messages.attachments')}
      >
        <PaperclipIcon class="size-icon-md" />
      </button>
    {/if}
  {/snippet}
</MessageBar>

{#if showAttachMenu}
  <div
    class="border-outline-variant bg-surface-container shadow-elevation-4 absolute bottom-16 left-4 grid w-48 grid-cols-2 gap-2 rounded-box border p-2"
    transition:fly={{ y: 20, duration: 200 }}
  >
    <button
      class="hover:bg-surface-container-high duration-short ease-standard flex flex-col items-center justify-center rounded-box p-3 transition-colors"
      onclick={onopenphotos}
    >
      <div
        class="bg-primary-container text-on-primary-container mb-1 flex h-8 w-8 items-center justify-center rounded-full"
      >
        <PhotoIcon class="size-icon-md" />
      </div>
      <span class="text-body-small">{$t('messages.photo')}</span>
    </button>
    <button
      class="hover:bg-surface-container-high duration-short ease-standard flex flex-col items-center justify-center rounded-box p-3 transition-colors"
      onclick={handleShareLocation}
    >
      <div
        class="mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-green-500/20 text-green-400"
      >
        <LocationIcon class="size-icon-md" />
      </div>
      <span class="text-body-small">{$t('messages.location')}</span>
    </button>
  </div>
{/if}

{#if showPicker}
  <PhotoPickerModal
    title={$t('messages.selectPhotos')}
    multiSelect={true}
    selectedIds={attachments.map((a) => a.photo_id)}
    onmultichange={(photoId: number, media: MediaPreview) => {
      const existing = attachments.find((a) => a.photo_id === photoId);
      if (existing) {
        attachments = attachments.filter((a) => a.photo_id !== photoId);
      } else if (attachments.length < MAX_ATTACHMENTS) {
        // The server refuses an over-cap array outright rather than truncating it, so the
        // picker has to stop here or an ordinary player meets an error the composer never
        // warned them about (MICA-154).
        attachments = [...attachments, { photo_id: photoId, media }];
      }
    }}
    onclose={() => (showPicker = false)}
  />
{/if}
