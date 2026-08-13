<script lang="ts">
  import { MediaThumb, useLocation, useAppAction } from '@gphone/sdk';
  import {
    useNavigation,
    useContacts,
    type UIMessage,
    type UIConversation,
    MessageStatusIcon,
    formatTime,
    Avatar,
    ReportButton,
    ReportDialog,
    ReplyIcon
  } from '@gphone/sdk';
  import type { Contact, MediaPreview } from '@shared/types';

  const { openApp } = useNavigation();
  const { contactsStore: contacts } = useContacts();
  const { setWaypoint } = useLocation();
  const { run } = useAppAction('messages');

  interface Props {
    msg: UIMessage;
    currentConv: UIConversation;
    isLastReadMyMessage: boolean;
    isReadByOther: boolean;
    onreply?: (msg: UIMessage) => void;
    onscrollto?: (msgId: number) => void;
  }

  let { msg, currentConv, isLastReadMyMessage, isReadByOther, onreply, onscrollto }: Props =
    $props();

  let showActions = $state(false);

  const getSenderInfo = (targetMsg: UIMessage = msg) => {
    if (targetMsg.sender === 'me') {
      return { name: 'You', avatar: undefined, contact: undefined };
    }
    if (!currentConv) return { name: 'Member', avatar: undefined, contact: undefined };
    const p = currentConv.participants?.find((part) => part.citizenid === targetMsg.citizenid);
    const contact = p?.contact || $contacts.find((c) => c.citizenid === targetMsg.citizenid);
    const name = contact
      ? `${contact.firstname} ${contact.lastname || ''}`.trim()
      : p?.citizenid || 'Member';
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
        const parsed = media.data ? JSON.parse(media.data) : null;
        const x = parsed?.x;
        const y = parsed?.y;
        if (typeof x !== 'number' || typeof y !== 'number') {
          throw new Error('Bad location data');
        }
        await setWaypoint(x, y);
      },
      { success: 'Waypoint set', error: 'Could not set waypoint' }
    );
  };
</script>

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
  class="mb-1.5 flex flex-col transition-all duration-300 {msg.sender === 'me'
    ? 'items-end'
    : 'items-start'}"
>
  {#if currentConv?.is_group && msg.sender === 'other'}
    {@const senderInfo = getSenderInfo()}
    <button
      type="button"
      class="group/sender mb-1 ml-1 flex cursor-pointer items-center gap-1.5 text-left transition-opacity hover:opacity-80"
      onclick={() => handleOpenSenderContact(senderInfo.contact)}
    >
      <Avatar
        src={senderInfo.avatar}
        initials={senderInfo.name[0] || '?'}
        size="w-4 h-4"
        textClass="text-[9px]"
        bgClass="bg-surface-container border border-outline-variant"
      />
      <span class="text-primary text-xs font-semibold group-hover/sender:underline">
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
      class="min-w-0 flex-1 cursor-pointer rounded-2xl px-4 py-2.5 text-left shadow-sm transition-all focus:outline-none {msg.sender ===
      'me'
        ? 'bg-primary-container text-on-primary-container rounded-tr-xs'
        : 'bg-surface-container text-on-surface rounded-tl-xs'}"
      onclick={() => (showActions = !showActions)}
    >
      {#if msg.replyToMsg}
        {@const replySender = getSenderInfo(msg.replyToMsg)}
        <div
          role="button"
          tabindex="0"
          class="border-primary bg-surface-container-high hover:bg-surface-container-highest mb-2 flex w-full flex-col overflow-hidden rounded-lg border-l-4 p-2 text-left text-xs transition-colors select-none"
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
          title="Jump to original message"
        >
          <div class="text-primary flex items-center gap-1.5 font-semibold">
            <Avatar
              src={replySender.avatar}
              initials={replySender.name[0] || '?'}
              size="w-3.5 h-3.5"
              textClass="text-[8px]"
              bgClass="bg-surface-container border border-outline-variant"
            />
            <span class="truncate text-[11px]">{replySender.name}</span>
          </div>
          <p class="mt-0.5 truncate text-[11px] opacity-80">
            {msg.replyToMsg.message || (msg.replyToMsg.attachments?.length ? '[Attachment]' : '')}
          </p>
        </div>
      {/if}

      {#if msg.attachments && msg.attachments.length > 0}
        <div class="mb-2 space-y-2">
          {#each msg.attachments as attach}
            {#if attach.media}
              {@const media = attach.media}
              {#if media.kind === 'location'}
                <div
                  role="button"
                  tabindex="0"
                  class="border-outline-variant hover:bg-surface-container-high flex w-full flex-col overflow-hidden rounded-lg border transition-colors"
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
                  <span class="text-primary px-2 py-1.5 text-xs font-semibold">Add Waypoint</span>
                </div>
              {:else}
                <div class="max-w-full overflow-hidden rounded-lg">
                  <MediaThumb item={media} fit="contain" alt="Attachment" />
                </div>
              {/if}
            {/if}
          {/each}
        </div>
      {/if}
      <p class="text-sm leading-relaxed whitespace-pre-wrap">
        {msg.message}
      </p>
    </button>

    {#if showActions}
      <button
        type="button"
        class="bg-surface-container-high text-on-surface-variant hover:bg-primary-container hover:text-on-primary-container flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full shadow-md transition-all active:scale-95"
        onclick={(e) => {
          e.stopPropagation();
          onreply?.(msg);
        }}
        title="Reply to message"
        aria-label="Reply to message"
      >
        <ReplyIcon class="h-4 w-4" />
      </button>
    {/if}
  </div>

  <div class="mt-1 flex items-center gap-1.5 px-1 select-none">
    {#if msg.sender === 'other'}
      <ReportButton subject="message" size="mini" onclick={() => (reporting = true)} />
    {/if}
    <span class="text-on-surface-variant text-[10px]">
      {formatTime(msg.created_at)}
    </span>
    {#if msg.sender === 'me' && currentConv}
      {#if isLastReadMyMessage}
        <MessageStatusIcon status="read" class="h-3.5 w-3.5" />
      {:else if !isReadByOther}
        <MessageStatusIcon status="delivered" class="h-3.5 w-3.5" />
      {/if}
    {/if}
  </div>
</div>
