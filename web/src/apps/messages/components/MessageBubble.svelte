<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { MediaThumb, useLocation, useAppAction, useLocale } from '@gphone/sdk';
  import {
    useNavigation,
    useContacts,
    type UIMessage,
    type UIConversation,
    MessageStatusIcon,
    formatTime,
    Avatar,
    ConfirmDialog,
    ReactionBar,
    ReportButton,
    ReportDialog,
    EditIcon,
    ReplyIcon,
    TrashIcon
  } from '@gphone/sdk';
  import type { Contact, MediaPreview, ReactionSummary } from '@gphone/shared/types';

  const { openApp } = useNavigation();
  const { contactsStore: contacts } = useContacts();
  const { setWaypoint } = useLocation();
  const { run } = useAppAction('messages');
  const { t } = useLocale();

  interface Props {
    msg: UIMessage;
    currentConv: UIConversation;
    isLastReadMyMessage: boolean;
    isReadByOther: boolean;
    onreply?: (msg: UIMessage) => void;
    onscrollto?: (msgId: number) => void;
    /** Load this message back into the composer for a rewrite. Own messages only. */
    onedit?: (msg: UIMessage) => void;
    /** Take the message back, for everyone. Own messages only, and confirmed first. */
    ondelete?: (msg: UIMessage) => Promise<void> | void;
    /** This message's reaction counts, if `messageReactions` has answered for it yet. */
    reactionSummary?: ReactionSummary | null;
    ontogglereaction?: (emoji: string) => void;
  }

  let {
    msg,
    currentConv,
    isLastReadMyMessage,
    isReadByOther,
    onreply,
    onscrollto,
    onedit,
    ondelete,
    reactionSummary = null,
    ontogglereaction
  }: Props = $props();

  let showActions = $state(false);

  /**
   * Editing and unsending are offered on your own messages only.
   *
   * The server says the same thing — `requireOwnMessage` scopes by the sender's citizenid
   * — so this is which buttons to draw, never the rule itself.
   */
  const isMine = $derived(msg.sender === 'me');

  let confirmingUnsend = $state(false);
  let unsending = $state(false);

  const handleUnsend = async () => {
    unsending = true;
    try {
      await ondelete?.(msg);
    } finally {
      unsending = false;
      confirmingUnsend = false;
      showActions = false;
    }
  };

  const getSenderInfo = (targetMsg: UIMessage = msg) => {
    if (targetMsg.sender === 'me') {
      return { name: $t('messages.you'), avatar: undefined, contact: undefined };
    }
    if (!currentConv) return { name: $t('messages.member'), avatar: undefined, contact: undefined };
    const p = currentConv.participants?.find((part) => part.citizenid === targetMsg.citizenid);
    const contact = p?.contact || $contacts.find((c) => c.citizenid === targetMsg.citizenid);
    const name = contact
      ? `${contact.firstname} ${contact.lastname || ''}`.trim()
      : p?.citizenid || $t('messages.member');
    const avatar = contact?.avatar;
    return { name, avatar, contact };
  };

  /**
   * Reporting is offered on other people's messages only. Reporting your own is not
   * moderation, and the server refuses it anyway — better not to offer the button.
   */
  let reporting = $state(false);

  const handleOpenSenderContact = (contact?: Contact) => {
    if (contact) {
      openApp('contacts', { initialContact: contact });
    }
  };

  /**
   * `media.data` is `JSON.stringify({x,y,z})` for a location row (`server/services/
   * Photos.ts`'s `shareLocation` action) — parsed here rather than trusted as anything
   * more than what it is, since it still crossed the network as ordinary message content.
   */
  const handleAddWaypoint = async (media: MediaPreview) => {
    await run(
      async () => {
        const parsed: unknown = media.data ? JSON.parse(media.data) : null;
        const { x, y } = (parsed ?? {}) as { x?: unknown; y?: unknown };
        if (typeof x !== 'number' || typeof y !== 'number') {
          throw new Error('Bad location data');
        }
        await setWaypoint(x, y);
      },
      { success: $t('messages.waypointSet'), error: $t('messages.waypointFailed') }
    );
  };
</script>

{#if confirmingUnsend}
  <ConfirmDialog
    title={$t('messages.unsendTitle')}
    message={$t('messages.unsendWarning')}
    confirmText={$t('messages.unsend')}
    isLoading={unsending}
    onconfirm={handleUnsend}
    oncancel={() => (confirmingUnsend = false)}
  />
{/if}

{#if reporting}
  <ReportDialog
    targetTable="gphone_messages"
    targetId={msg.id}
    appId="messages"
    onclose={() => (reporting = false)}
  />
{/if}

<div
  id={`msg-${msg.id}`}
  class="duration-medium ease-emphasized mb-1.5 flex flex-col transition-all {msg.sender === 'me'
    ? 'items-end'
    : 'items-start'}"
>
  {#if currentConv?.is_group && msg.sender === 'other'}
    {@const senderInfo = getSenderInfo()}
    <button
      type="button"
      class="group/sender duration-short ease-standard mb-1 ml-1 flex cursor-pointer items-center gap-1.5 text-left transition-opacity hover:opacity-80"
      onclick={() => handleOpenSenderContact(senderInfo.contact)}
    >
      <Avatar
        src={senderInfo.avatar}
        initials={senderInfo.name[0] || '?'}
        size="w-4 h-4"
        textClass="text-label-small"
        bgClass="bg-surface-container border border-outline-variant"
      />
      <span class="text-primary text-body-small group-hover/sender:underline">
        {senderInfo.name}
      </span>
    </button>
  {/if}

  <!-- Message row container: flex row with message bubble + prominent side reply button -->
  <div
    class="flex max-w-[85%] items-center gap-2 {msg.sender === 'me'
      ? 'flex-row-reverse'
      : 'flex-row'}"
  >
    <button
      type="button"
      class="shadow-elevation-1 min-w-0 flex-1 cursor-pointer rounded-box px-4 py-2.5 text-left transition-all focus:outline-none {msg.sender ===
      'me'
        ? 'bg-primary-container text-on-primary-container rounded-tr-xs'
        : 'bg-surface-container text-on-surface rounded-tl-xs'} duration-short ease-standard"
      onclick={() => (showActions = !showActions)}
    >
      {#if msg.replyToMsg}
        {@const replySender = getSenderInfo(msg.replyToMsg)}
        <div
          role="button"
          tabindex="0"
          class="border-primary bg-surface-container-high hover:bg-surface-container-highest duration-short ease-standard text-body-small mb-2 flex w-full flex-col overflow-hidden rounded-box border-l-4 p-2 text-left transition-colors select-none"
          onclick={(e) => {
            e.stopPropagation();
            onscrollto?.(msg.replyToMsg!.id);
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              onscrollto?.(msg.replyToMsg!.id);
            }
          }}
          title={$t('messages.jumpToOriginal')}
        >
          <div class="text-primary flex items-center gap-1.5 font-semibold">
            <Avatar
              src={replySender.avatar}
              initials={replySender.name[0] || '?'}
              size="w-3.5 h-3.5"
              textClass="text-label-small"
              bgClass="bg-surface-container border border-outline-variant"
            />
            <span class="text-label-small truncate">{replySender.name}</span>
          </div>
          <p class="text-label-small mt-0.5 truncate opacity-80">
            {msg.replyToMsg.message ||
              (msg.replyToMsg.attachments?.length ? $t('messages.attachmentTag') : '')}
          </p>
        </div>
      {/if}

      {#if msg.attachments && msg.attachments.length > 0}
        <div class="mb-2 space-y-2">
          {#each msg.attachments as attach (attach.id ?? attach.photo_id)}
            {#if attach.media}
              {@const media = attach.media}
              {#if media.kind === 'location'}
                <div
                  role="button"
                  tabindex="0"
                  class="border-outline-variant hover:bg-surface-container-high duration-short ease-standard flex w-full flex-col overflow-hidden rounded-box border transition-colors"
                  onclick={(e) => {
                    e.stopPropagation();
                    handleAddWaypoint(media);
                  }}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation();
                      handleAddWaypoint(media);
                    }
                  }}
                >
                  <div class="h-24 w-full">
                    <MediaThumb item={media} fit="contain" />
                  </div>
                  <span class="text-primary text-body-small px-2 py-1.5"
                    >{$t('messages.addWaypoint')}</span
                  >
                </div>
              {:else}
                <div data-testid="attachment-slot" class="max-w-full overflow-hidden rounded-box">
                  <MediaThumb item={media} fit="contain" alt={$t('messages.attachment')} />
                </div>
              {/if}
            {/if}
          {/each}
        </div>
      {/if}
      <p class="text-body-medium leading-relaxed whitespace-pre-wrap">
        {msg.message}
      </p>
    </button>

    {#if showActions}
      <div class="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          class="bg-surface-container-high text-on-surface-variant hover:bg-primary-container hover:text-on-primary-container shadow-elevation-2 duration-short ease-standard flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all active:scale-95"
          onclick={(e) => {
            e.stopPropagation();
            onreply?.(msg);
          }}
          title={$t('messages.replyToMessage')}
          aria-label={$t('messages.replyToMessage')}
        >
          <ReplyIcon class="size-icon-sm" />
        </button>

        {#if isMine}
          <button
            type="button"
            class="bg-surface-container-high text-on-surface-variant hover:bg-primary-container hover:text-on-primary-container shadow-elevation-2 duration-short ease-standard flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all active:scale-95"
            onclick={(e) => {
              e.stopPropagation();
              showActions = false;
              onedit?.(msg);
            }}
            title={$t('messages.editMessage')}
            aria-label={$t('messages.editMessage')}
          >
            <EditIcon class="size-icon-sm" />
          </button>
          <!-- "Unsend", not "Delete". The message goes from everyone's thread, and the
               word has to say so before the confirmation does. -->
          <button
            type="button"
            class="bg-surface-container-high text-on-surface-variant hover:bg-error-container hover:text-on-error-container shadow-elevation-2 duration-short ease-standard flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all active:scale-95"
            onclick={(e) => {
              e.stopPropagation();
              confirmingUnsend = true;
            }}
            title={$t('messages.unsendMessage')}
            aria-label={$t('messages.unsendMessage')}
          >
            <TrashIcon class="size-icon-sm" />
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="mt-1 flex items-center gap-1.5 px-1 select-none">
    {#if msg.sender === 'other'}
      <ReportButton subject="message" size="mini" onclick={() => (reporting = true)} />
    {/if}
    <span class="text-on-surface-variant text-label-small">
      {formatTime(msg.created_at)}
    </span>
    <!-- Shown to *both* sides, and that is the point: an edit the recipient cannot see is
         a rewrite of what they already read. `edited` is derived server-side from
         `updated_at > created_at`, so it survives a reload rather than living only in the
         sender's session. -->
    {#if msg.edited}
      <span class="text-on-surface-variant text-label-small italic"
        >{$t('messages.editedLabel')}</span
      >
    {/if}
    {#if msg.sender === 'me' && currentConv}
      {#if isLastReadMyMessage}
        <MessageStatusIcon status="read" class="h-3.5 w-3.5" />
      {:else if !isReadByOther}
        <MessageStatusIcon status="delivered" class="h-3.5 w-3.5" />
      {/if}
    {/if}
  </div>

  <!-- Aligned by the outer column's own `items-end`/`items-start`, exactly like the
       timestamp row above — no group-vs-DM branching needed here: a summary is a bare
       count plus "mine", which reads the same regardless of how many participants the
       thread has (see `conversations.ts`'s docblock on `messageReactions`). -->
  <ReactionBar
    summary={reactionSummary}
    ontoggle={(emoji: string) => ontogglereaction?.(emoji)}
    class="px-1"
  />
</div>
