<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { MAX_ATTACHMENTS } from '@mica/shared/attachments';
  import { Button, PhotoPickerModal, useLocale, useMarketplace } from '@mica/sdk';
  import type { MediaPreview } from '@mica/shared/types';

  let { onposted, oncancel }: { onposted: (id: number) => void; oncancel: () => void } = $props();

  const { postListing } = useMarketplace();
  const { t } = useLocale();

  let title = $state('');
  // `type="number"` binds a `number` (or `''` when empty), not a string — Svelte coerces it.
  let price = $state<number | ''>('');
  let description = $state('');
  let attachments = $state<{ photo_id: number; media: MediaPreview }[]>([]);
  let showPicker = $state(false);
  let busy = $state(false);

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
    placeholder={$t('marketplace.titlePlaceholder')}
    bind:value={title}
    class="bg-surface-container text-on-surface rounded-box px-3 py-2"
  />
  <input
    placeholder={$t('marketplace.pricePlaceholder')}
    type="number"
    min="0"
    bind:value={price}
    class="bg-surface-container text-on-surface rounded-box px-3 py-2"
  />
  <textarea
    placeholder={$t('marketplace.descriptionPlaceholder')}
    bind:value={description}
    class="bg-surface-container text-on-surface rounded-box px-3 py-2"></textarea>

  <button
    type="button"
    onclick={() => (showPicker = true)}
    class="text-primary text-label-large self-start"
  >
    {$t('marketplace.addPhotos', { count: attachments.length, max: MAX_ATTACHMENTS })}
  </button>

  <div class="flex justify-end gap-2">
    <Button variant="secondary" onclick={oncancel}>{$t('marketplace.cancel')}</Button>
    <Button disabled={!canPost} onclick={submit}>{$t('marketplace.post')}</Button>
  </div>
</div>

{#if showPicker}
  <PhotoPickerModal
    title={$t('marketplace.selectPhotos')}
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
