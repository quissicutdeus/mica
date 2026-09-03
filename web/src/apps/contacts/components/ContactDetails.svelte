<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

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
    useLocale,
    type Contact,
    type UIMessage
  } from '@gos/sdk';

  const { t } = useLocale();

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
  class="animate-in fade-in slide-in-from-right duration-medium ease-emphasized flex flex-col items-center space-y-6 p-6"
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
      class="border-surface bg-primary-container text-on-primary-container hover:bg-primary-container-hover shadow-elevation-3 duration-short ease-standard absolute right-0 bottom-0 flex items-center justify-center rounded-full border-2 p-2 transition-transform active:scale-95"
      onclick={() => onpickphoto()}
      aria-label={$t('contacts.selectPhotoFromGallery')}
      title={$t('contacts.selectPhotoFromGallery')}
    >
      <EditIcon class="size-icon-sm" />
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
      class="duration-short ease-standard rounded-full p-1 transition-transform hover:scale-110 active:scale-95"
      onclick={ontogglefavorite}
      aria-label={$t('contacts.toggleFavorite')}
      title={contact.favorite ? $t('contacts.removeFromFavorites') : $t('contacts.addToFavorites')}
    >
      <StarIcon
        filled={contact.favorite}
        class={contact.favorite
          ? 'size-icon-lg text-yellow-400'
          : 'text-on-surface-variant size-icon-lg hover:text-yellow-400'}
      />
    </button>
  </div>

  <!-- Actions Row -->
  <div class="flex space-x-4">
    <Button
      variant="icon"
      class="bg-green-600 text-white hover:bg-green-500 hover:text-white"
      onclick={oncall}
      aria-label={$t('contacts.call')}
    >
      <!-- Call Icon -->
      <PhoneIcon />
    </Button>
    <Button
      variant="icon"
      class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover hover:text-on-primary"
      onclick={onmessage}
      aria-label={$t('contacts.message')}
    >
      <!-- Message Icon -->
      <MessageIcon />
    </Button>

    <Button
      variant="icon"
      class="bg-surface-container-high text-on-surface hover:bg-surface-container-highest hover:text-on-surface"
      onclick={onshare}
      disabled={busy || !contact?.firstname?.trim() || !contact?.phone?.trim()}
      aria-label={$t('contacts.share')}
    >
      <!-- Share Icon -->
      <ShareIcon />
    </Button>
    <Button
      variant="icon"
      class="bg-surface-container-high text-on-surface hover:bg-surface-container-highest hover:text-on-surface"
      onclick={() => onedit()}
      aria-label={$t('contacts.edit')}
    >
      <!-- Edit Icon -->
      <EditIcon />
    </Button>
    <Button
      variant="icon"
      class="text-error hover:text-error bg-red-900/50 hover:bg-red-900/80"
      onclick={ondelete}
      disabled={busy}
      aria-label={$t('contacts.delete')}
    >
      <!-- Trash Icon -->
      <TrashIcon />
    </Button>
  </div>

  <!-- Details List / Edit Form -->
  <div class="bg-surface-container shadow-elevation-3 w-full space-y-4 rounded-box p-4">
    {#if isEditing}
      <div class="space-y-3">
        <input
          class="bg-surface-container-high w-full rounded-chip p-2"
          maxlength="50"
          bind:value={contact.firstname}
          placeholder={$t('contacts.firstName')}
        />
        <input
          class="bg-surface-container-high w-full rounded-chip p-2"
          maxlength="50"
          bind:value={contact.lastname}
          placeholder={$t('contacts.lastName')}
        />
        <input
          class="bg-surface-container-high w-full rounded-chip p-2"
          bind:value={contact.phone}
          placeholder={$t('contacts.phoneRequired')}
        />
        <label class="flex items-center space-x-2">
          <input type="checkbox" bind:checked={contact.favorite} />
          <span>{$t('contacts.favorite')}</span>
        </label>
        <Button
          class="w-full"
          onclick={onsave}
          disabled={busy || !contact.firstname.trim() || !contact.phone.trim()}
        >
          {busy ? $t('contacts.saving') : $t('contacts.saveChanges')}
        </Button>
      </div>
    {:else}
      <div class="flex flex-col">
        <span class="text-on-surface-variant text-body-small tracking-wider uppercase"
          >{$t('contacts.phone')}</span
        >
        <span class="text-lg">{contact.phone}</span>
      </div>
    {/if}
  </div>

  <!-- Recent Text Messages Card -->
  <div
    class="border-outline-variant bg-surface-container shadow-elevation-3 w-full overflow-hidden rounded-box border"
  >
    <div
      class="border-outline-variant bg-surface-container flex items-center justify-between border-b px-4 py-3"
    >
      <div class="flex items-center gap-2">
        <MessageIcon class="text-primary size-icon-sm" />
        <h4 class="text-on-surface text-body-small tracking-wider uppercase">
          {$t('contacts.recentTextMessages')}
        </h4>
      </div>
      {#if messageCount > 0}
        <button
          type="button"
          class="text-primary hover:text-primary duration-short ease-standard text-body-small cursor-pointer transition-colors"
          onclick={onmessage}
        >
          {$t('contacts.viewAll', { count: messageCount })}
        </button>
      {/if}
    </div>

    {#if recentMessages.length > 0}
      <div class="divide-outline-variant divide-y">
        {#each recentMessages as msg (msg.id)}
          <button
            type="button"
            class="group hover:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between gap-3 p-3.5 text-left transition-colors"
            onclick={onmessage}
          >
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex items-center gap-2">
                <span
                  class="text-body-small {msg.sender === 'me' ? 'text-primary' : 'text-on-surface'}"
                >
                  {msg.sender === 'me' ? $t('contacts.you') : contact.firstname}
                </span>
                <span class="text-on-surface-variant text-label-small">•</span>
                <span class="text-on-surface-variant text-label-small">
                  {formatRelativeTime(msg.created_at)}
                </span>
              </div>
              <p class="text-on-surface text-body-small truncate leading-relaxed">
                {msg.message}
              </p>
            </div>
            <ChevronRightIcon
              class="text-outline group-hover:text-on-surface-variant duration-short ease-standard size-icon-sm shrink-0 transition-colors"
            />
          </button>
        {/each}
      </div>
    {:else}
      <div
        class="text-on-surface-variant text-body-small flex flex-col items-center gap-2 p-6 text-center"
      >
        <MessageIcon class="text-outline mb-1 h-8 w-8" />
        <span>{$t('contacts.noRecentMessages', { name: contact.firstname })}</span>
        <button
          type="button"
          class="border-primary bg-primary-container text-on-primary-container hover:bg-primary-container-hover duration-short ease-standard text-body-small mt-1 cursor-pointer rounded-box border px-3 py-1 transition-all"
          onclick={onmessage}
        >
          {$t('contacts.sendTextMessage')}
        </button>
      </div>
    {/if}
  </div>
</div>
