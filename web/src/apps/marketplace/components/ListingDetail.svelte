<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Button,
    MediaThumb,
    ReportButton,
    ReportDialog,
    Skeleton,
    useCall,
    useLocale,
    useMarketplace,
    useMessages
  } from '@mica/sdk';
  import type { Listing } from '@mica/shared/types';

  let { id, onback }: { id: number; onback: () => void } = $props();

  const { viewListing } = useMarketplace();
  const { startCall } = useCall();
  const { startText } = useMessages();
  const { t } = useLocale();

  let listing = $state<(Listing & { contactPhone: string | null; isOwn: boolean }) | null>(null);
  let reporting = $state(false);

  onMount(async () => {
    listing = await viewListing(id);
  });
</script>

<div class="flex items-center gap-2 p-4">
  <button
    type="button"
    onclick={onback}
    aria-label={$t('marketplace.back')}
    class="text-on-surface-variant"
  >
    ←
  </button>
</div>

{#if !listing}
  <div class="p-4"><Skeleton count={3} height="h-20" /></div>
{:else}
  <div class="flex flex-col gap-3 p-4">
    {#if listing.attachments && listing.attachments.length > 0}
      <div class="flex gap-2 overflow-x-auto">
        {#each listing.attachments as att (att.id)}
          <MediaThumb item={att.media} class="h-40 w-40 shrink-0 rounded-box" />
        {/each}
      </div>
    {/if}
    <p class="text-on-surface text-title-large">{listing.title}</p>
    <p class="text-on-surface-variant text-body-large">{listing.price}</p>
    <p class="text-on-surface text-body-medium">{listing.description}</p>

    <div class="mt-2 flex items-center gap-2">
      {#if listing.contactPhone}
        <Button onclick={() => startCall(listing!.contactPhone!)}>{$t('marketplace.call')}</Button>
        <Button variant="secondary" onclick={() => startText(listing!.contactPhone!)}
          >{$t('marketplace.text')}</Button
        >
      {/if}
      {#if !listing.isOwn}
        <ReportButton subject="listing" size="header" onclick={() => (reporting = true)} />
      {/if}
    </div>
  </div>
{/if}

{#if reporting}
  <ReportDialog
    targetTable="mica_marketplace"
    targetId={id}
    appId="marketplace"
    onclose={() => (reporting = false)}
  />
{/if}
