<script lang="ts">
  import { fade } from 'svelte/transition';
  import Button from './Button.svelte';
  import { fetchNui } from '../../nui/fetchNui';
  import { toast } from '../../shell/state/toast';
  import type { ReportCategory } from '@shared/types';
  import { messageOf } from '../../lib/errors';

  interface Props {
    /** The gPhone table the content lives in. Validated again server-side. */
    targetTable: 'gphone_messages' | 'gphone_photos';
    targetId: number;
    onclose: () => void;
  }

  let { targetTable, targetId, onclose }: Props = $props();

  const CATEGORIES: { id: ReportCategory; label: string }[] = [
    { id: 'harassment', label: 'Harassment' },
    { id: 'threats', label: 'Threats or violence' },
    { id: 'sexual', label: 'Sexual content' },
    { id: 'spam', label: 'Spam' },
    { id: 'impersonation', label: 'Impersonation' },
    { id: 'other', label: 'Something else' }
  ];

  let category = $state<ReportCategory>('harassment');
  let note = $state('');
  let sending = $state(false);

  /** Matches the server's cap, so the field cannot accept what would be silently cut. */
  const MAX_NOTE = 500;

  const submit = async () => {
    sending = true;
    try {
      const res = await fetchNui<{ ok?: boolean; error?: string }>('createReport', {
        targetTable,
        targetId,
        category,
        note: note.trim() || undefined
      });
      if (res?.error) throw new Error(res.error);
      toast.show({ type: 'success', message: 'Report sent for review' });
      onclose();
    } catch (e) {
      toast.show({ type: 'error', message: messageOf(e, 'Could not send the report') });
    } finally {
      sending = false;
    }
  };
</script>

<div
  class="absolute inset-0 z-50 flex items-end bg-black/80 backdrop-blur-sm"
  transition:fade={{ duration: 150 }}
>
  <div class="max-h-full w-full overflow-y-auto rounded-t-3xl bg-gray-900 p-5">
    <h3 class="mb-1 text-lg font-bold text-white">Report content</h3>
    <p class="mb-4 text-sm text-gray-400">A moderator reviews this. The author is not told.</p>

    <div class="mb-4 space-y-1.5">
      {#each CATEGORIES as option (option.id)}
        <button
          type="button"
          onclick={() => (category = option.id)}
          aria-pressed={category === option.id}
          class="flex w-full cursor-pointer items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-colors {category ===
          option.id
            ? 'border-rose-500 bg-rose-950/50 text-white'
            : 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700'}"
        >
          {option.label}
          {#if category === option.id}
            <span class="text-rose-400">●</span>
          {/if}
        </button>
      {/each}
    </div>

    <textarea
      bind:value={note}
      maxlength={MAX_NOTE}
      rows="3"
      placeholder="Anything else the moderator should know (optional)"
      class="mb-4 w-full resize-none rounded-xl border border-gray-700 bg-gray-800 p-3 text-sm text-white placeholder-gray-500 focus:border-rose-500 focus:outline-none"
    ></textarea>

    <div class="flex gap-3">
      <Button class="flex-1" variant="secondary" onclick={onclose} disabled={sending}>Cancel</Button
      >
      <Button class="flex-1" variant="danger" onclick={submit} disabled={sending}>
        {sending ? 'Sending…' : 'Report'}
      </Button>
    </div>
  </div>
</div>
