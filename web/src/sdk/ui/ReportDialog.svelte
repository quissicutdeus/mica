<script lang="ts">
  import { fade } from 'svelte/transition';
  import Button from './Button.svelte';
  import { fetchNui } from '../../nui/fetchNui';
  import { toast } from '../../shell/state/toast';
  import type { ReportCategory } from '@shared/types';
  import { messageOf } from '../../lib/errors';

  interface Props {
    /** The gPhone table the content lives in. Validated again server-side. */
    /**
     * The table the reported row lives in, as its service declared it reportable.
     *
     * A plain string, deliberately. It was briefly a union naming every table — which
     * meant this file, in the SDK that add-ons build *against*, named `gphone_blabber`:
     * core knowing about an app rather than the other way round, and the reason a
     * third-party app could not have made its own content reportable at all.
     *
     * The check that matters is server-side and unchanged: `target_table` is interpolated
     * into SQL because MySQL cannot parameterise an identifier, so `isReportableTable`
     * refuses anything no service declared (§2.9). A union here would have been a
     * convenience on top of that, bought at the price of a closed system.
     */
    targetTable: string;
    targetId: number;
    /** Which app's icon/name a confirmation toast identifies itself with. */
    appId?: string;
    onclose: () => void;
  }

  let { targetTable, targetId, appId, onclose }: Props = $props();

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
      toast.show({ type: 'success', app: appId, message: 'Report sent for review' });
      onclose();
    } catch (e) {
      toast.show({ type: 'error', app: appId, message: messageOf(e, 'Could not send the report') });
    } finally {
      sending = false;
    }
  };
</script>

<div
  class="bg-scrim absolute inset-0 z-50 flex items-end backdrop-blur-sm"
  transition:fade={{ duration: 150 }}
>
  <div class="bg-surface max-h-full w-full overflow-y-auto rounded-t-xl p-5">
    <h3 class="text-on-surface mb-1 text-lg font-bold">Report content</h3>
    <p class="text-on-surface-variant text-body-medium mb-4">
      A moderator reviews this. The author is not told.
    </p>

    <div class="mb-4 space-y-1.5">
      {#each CATEGORIES as option (option.id)}
        <button
          type="button"
          onclick={() => (category = option.id)}
          aria-pressed={category === option.id}
          class="text-body-medium flex w-full cursor-pointer items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors {category ===
          option.id
            ? 'border-error bg-error-container text-on-error-container'
            : 'border-outline-variant bg-surface-container text-on-surface hover:bg-surface-container-high'} duration-short ease-standard"
        >
          {option.label}
          {#if category === option.id}
            <span class="text-error">●</span>
          {/if}
        </button>
      {/each}
    </div>

    <textarea
      bind:value={note}
      maxlength={MAX_NOTE}
      rows="3"
      placeholder="Anything else the moderator should know (optional)"
      class="border-outline-variant bg-surface-container text-on-surface placeholder-on-surface-variant focus:border-error text-body-medium mb-4 w-full resize-none rounded-xl border p-3 focus:outline-none"
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
