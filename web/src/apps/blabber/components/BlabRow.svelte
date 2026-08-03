<script lang="ts">
  import { Avatar, formatDate } from '@gphone/sdk';
  import type { Blab } from '@shared/types';
  import BlabBody from './BlabBody.svelte';

  let {
    blab,
    editable = false,
    onhandle,
    onedit,
    ondelete
  }: {
    blab: Blab;
    editable?: boolean;
    onhandle?: (handle: string) => void;
    onedit?: (blab: Blab) => void;
    ondelete?: (blab: Blab) => void;
  } = $props();

  /**
   * `updated_at > created_at` — derived, never stored.
   *
   * Both columns stamp identically on insert and `updated_at` carries
   * `ON UPDATE CURRENT_TIMESTAMP`, so the row already knows. An `is_edited` column would be a
   * second copy of a fact free to drift from the first.
   */
  const edited = $derived(
    new Date(blab.updated_at).getTime() - new Date(blab.created_at).getTime() > 1000
  );
</script>

<article class="flex gap-3 border-b border-gray-800 px-4 py-3">
  <Avatar
    src={blab.avatar ?? undefined}
    initials={(blab.handle ?? '?').slice(0, 2).toUpperCase()}
    size="w-9 h-9"
    showSilhouette={!blab.handle}
  />

  <div class="min-w-0 flex-1">
    <div class="flex items-baseline gap-1.5 text-xs">
      <button
        type="button"
        class="truncate font-semibold text-white hover:underline"
        onclick={() => blab.handle && onhandle?.(blab.handle)}
      >
        {blab.display_name || blab.handle}
      </button>
      <span class="truncate text-gray-500">@{blab.handle}</span>
      <span class="text-gray-600">·</span>
      <span class="shrink-0 text-gray-500">{formatDate(blab.created_at)}</span>
      {#if edited}
        <span class="shrink-0 text-gray-600 italic">edited</span>
      {/if}
    </div>

    <div class="mt-1">
      <BlabBody body={blab.body} {onhandle} />
    </div>

    {#if editable}
      <div class="mt-2 flex gap-3 text-xs">
        <button type="button" class="text-sky-400 hover:underline" onclick={() => onedit?.(blab)}>
          Edit
        </button>
        <button type="button" class="text-red-400 hover:underline" onclick={() => ondelete?.(blab)}>
          Delete
        </button>
      </div>
    {/if}
  </div>
</article>
