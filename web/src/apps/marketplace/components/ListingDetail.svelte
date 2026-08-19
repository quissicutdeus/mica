<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Button,
    MediaThumb,
    ReportButton,
    ReportDialog,
    Skeleton,
    useCall,
    useMarketplace,
    useNavigation
  } from '@gphone/sdk';
  import type { Contact, Listing } from '@shared/types';

  let { id, onback }: { id: number; onback: () => void } = $props();

  const { viewListing } = useMarketplace();
  const { startCall } = useCall();
  const { openApp } = useNavigation();

  let listing = $state<(Listing & { contactPhone: string | null; isOwn: boolean }) | null>(null);
  let reporting = $state(false);

  onMount(async () => {
    listing = await viewListing(id);
  });

  const contactFor = (phone: string): Contact => ({
    id: 0,
    citizenid: '',
    firstname: phone,
    phone,
    favorite: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
</script>

<div class="flex items-center gap-2 p-4">
  <button type="button" onclick={onback} aria-label="Back" class="text-on-surface-variant">
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
          <MediaThumb item={att.media} class="h-40 w-40 shrink-0 rounded-xl" />
        {/each}
      </div>
    {/if}
    <p class="text-on-surface text-title-large">{listing.title}</p>
    <p class="text-on-surface-variant text-body-large">{listing.price}</p>
    <p class="text-on-surface text-body-medium">{listing.description}</p>

    <div class="mt-2 flex items-center gap-2">
      {#if listing.contactPhone}
        <Button onclick={() => startCall(listing!.contactPhone!)}>Call</Button>
        <Button
          variant="secondary"
          onclick={() =>
            openApp('messages', { initialContact: contactFor(listing!.contactPhone!) })}
        >
          Text
        </Button>
      {/if}
      {#if !listing.isOwn}
        <ReportButton subject="listing" size="header" onclick={() => (reporting = true)} />
      {/if}
    </div>
  </div>
{/if}

{#if reporting}
  <ReportDialog
    targetTable="gphone_marketplace"
    targetId={id}
    appId="marketplace"
    onclose={() => (reporting = false)}
  />
{/if}
