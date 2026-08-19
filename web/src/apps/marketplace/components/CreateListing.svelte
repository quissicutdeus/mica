<script lang="ts">
  import { Button, PhotoPickerModal, useMarketplace } from '@gphone/sdk';
  import type { MediaPreview } from '@shared/types';

  let { onposted, oncancel }: { onposted: (id: number) => void; oncancel: () => void } = $props();

  const { postListing } = useMarketplace();

  let title = $state('');
  // `type="number"` binds a `number` (or `''` when empty), not a string — Svelte coerces it.
  let price = $state<number | ''>('');
  let description = $state('');
  let attachments = $state<{ photo_id: number; media: MediaPreview }[]>([]);
  let showPicker = $state(false);
  let busy = $state(false);

  const MAX_ATTACHMENTS = 4;

  const canPost = $derived(
    title.trim().length > 0 &&
      description.trim().length > 0 &&
      price !== '' &&
      Number.isInteger(Number(price)) &&
      Number(price) >= 0 &&
      !busy
  );

  const submit = async () => {
    busy = true;
    try {
      const created = await postListing({
        title: title.trim(),
        price: Number(price),
        description: description.trim(),
        attachments: attachments.map((a) => ({ photo_id: a.photo_id }))
      });
      onposted(created.id);
    } finally {
      busy = false;
    }
  };
</script>

<div class="flex flex-col gap-3 p-4">
  <input
    placeholder="Title"
    bind:value={title}
    class="bg-surface-container text-on-surface rounded-lg px-3 py-2"
  />
  <input
    placeholder="Price"
    type="number"
    min="0"
    bind:value={price}
    class="bg-surface-container text-on-surface rounded-lg px-3 py-2"
  />
  <textarea
    placeholder="Description"
    bind:value={description}
    class="bg-surface-container text-on-surface rounded-lg px-3 py-2"></textarea>

  <button
    type="button"
    onclick={() => (showPicker = true)}
    class="text-primary text-label-large self-start"
  >
    Add photos ({attachments.length}/{MAX_ATTACHMENTS})
  </button>

  <div class="flex justify-end gap-2">
    <Button variant="secondary" onclick={oncancel}>Cancel</Button>
    <Button disabled={!canPost} onclick={submit}>Post</Button>
  </div>
</div>

{#if showPicker}
  <PhotoPickerModal
    title="Select Photos"
    multiSelect={true}
    selectedIds={attachments.map((a) => a.photo_id)}
    onmultichange={(photoId: number, media: MediaPreview) => {
      const existing = attachments.find((a) => a.photo_id === photoId);
      if (existing) {
        attachments = attachments.filter((a) => a.photo_id !== photoId);
      } else if (attachments.length < MAX_ATTACHMENTS) {
        attachments = [...attachments, { photo_id: photoId, media }];
      }
    }}
    onclose={() => (showPicker = false)}
  />
{/if}
