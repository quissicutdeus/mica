<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Avatar, Button, EmptyState, SegmentedControl, useLocale } from '@mica/sdk';
  import type { Contact } from '@mica/shared/types';
  import { MAX_LIVE_SHARE_RECIPIENTS } from '@mica/shared/contracts/places';

  /**
   * Pick who sees your live location, and for how long (MICA-244). Contacts only: the server
   * reads each id back out of your own address book, so there is nothing else to offer here.
   */
  let {
    contacts,
    durations,
    busy,
    onstart,
    oncancel
  }: {
    contacts: Contact[];
    durations: readonly number[];
    busy: boolean;
    onstart: (contactIds: number[], minutes: number) => void;
    oncancel: () => void;
  } = $props();

  const { t } = useLocale();

  let chosen = $state<number[]>([]);
  let duration = $state('');

  const selectedDuration = $derived(duration || String(durations[0] ?? 15));

  const durationLabel = (minutes: number) =>
    minutes < 60
      ? $t('places.durationMinutes', { count: minutes })
      : $t('places.durationHours', { count: minutes / 60 });

  const options = $derived(durations.map((m) => ({ id: String(m), label: durationLabel(m) })));

  const toggle = (id: number) => {
    if (chosen.includes(id)) chosen = chosen.filter((c) => c !== id);
    else if (chosen.length < MAX_LIVE_SHARE_RECIPIENTS) chosen = [...chosen, id];
  };

  const nameOf = (contact: Contact) =>
    [contact.firstname, contact.lastname].filter(Boolean).join(' ');
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
  <p class="text-on-surface-variant text-body-small px-1">{$t('places.shareLiveHint')}</p>
  <SegmentedControl
    {options}
    selected={selectedDuration}
    onchange={(id: string) => (duration = id)}
    aria-label={$t('places.shareDuration')}
  />
  <div class="no-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
    {#if contacts.length === 0}
      <EmptyState title={$t('places.noContacts')} />
    {:else}
      {#each contacts as contact (contact.id)}
        {@const on = chosen.includes(contact.id)}
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          class="hover:bg-surface-container-high duration-short ease-standard flex w-full items-center gap-3 rounded-box p-2 text-left transition-colors {on
            ? 'bg-surface-container-high'
            : ''}"
          onclick={() => toggle(contact.id)}
          disabled={busy}
        >
          <Avatar src={contact.avatar} initials={contact.firstname.slice(0, 1)} />
          <span class="text-on-surface min-w-0 flex-1 truncate">{nameOf(contact)}</span>
          <span
            class="size-icon-sm shrink-0 rounded-full border-2 {on
              ? 'bg-primary border-primary'
              : 'border-outline'}"
            aria-hidden="true"
          ></span>
        </button>
      {/each}
    {/if}
  </div>
  <div class="flex gap-2">
    <Button class="flex-1" variant="secondary" onclick={oncancel} disabled={busy}>
      {$t('places.cancel')}
    </Button>
    <Button
      class="flex-1"
      onclick={() => onstart(chosen, Number(selectedDuration))}
      disabled={busy || chosen.length === 0}
    >
      {$t('places.startSharing')}
    </Button>
  </div>
</div>
