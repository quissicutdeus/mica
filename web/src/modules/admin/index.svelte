<script lang="ts">
  import {
    Screen,
    EmptyState,
    ConfirmDialog,
    useNuiBridge,
    usePhoneNotification,
    onAppMount,
    formatRelativeTime
  } from '@gphone/sdk';
  import type { Report } from '@shared/types';

  let { onback } = $props<{ onback?: () => void }>();

  const { fetchNui } = useNuiBridge();
  const { toast } = usePhoneNotification();

  let queue = $state<Report[]>([]);
  let loading = $state(true);
  let pendingAction = $state<{ report: Report; action: 'moderate' | 'dismiss' } | null>(null);

  const CATEGORY_LABELS: Record<string, string> = {
    spam: 'Spam',
    harassment: 'Harassment',
    threats: 'Threats or violence',
    sexual: 'Sexual content',
    impersonation: 'Impersonation',
    other: 'Other'
  };

  const load = async () => {
    loading = true;
    try {
      const rows = await fetchNui<Report[]>('getReportQueue', {});
      queue = Array.isArray(rows) ? rows : [];
    } catch (e: any) {
      // The server refuses a non-admin outright. Say so rather than showing an empty
      // queue, which reads as "nothing to do".
      toast.show({ type: 'error', message: e?.message || 'Could not load the report queue' });
      queue = [];
    } finally {
      loading = false;
    }
  };

  onAppMount(() => void load());

  const resolve = async (report: Report, action: 'moderate' | 'dismiss') => {
    try {
      const res = await fetchNui<{ ok?: boolean; error?: string }>('resolveReport', {
        id: report.id,
        action
      });
      if (res?.error) throw new Error(res.error);

      toast.show({
        type: 'success',
        message: action === 'moderate' ? 'Content hidden' : 'Report dismissed'
      });
      queue = queue.filter((r) => r.id !== report.id);
    } catch (e: any) {
      toast.show({ type: 'error', message: e?.message || 'Could not resolve the report' });
    } finally {
      pendingAction = null;
    }
  };

  /** A photo's preview is a base64 data URI; anything else is text. */
  const isImagePreview = (preview?: string) => Boolean(preview?.startsWith('data:image'));
</script>

<Screen title="Administration" {onback}>
  <div class="space-y-4 p-4">
    <h2 class="px-1 text-sm font-medium tracking-wider text-gray-400 uppercase">
      Pending reports{queue.length ? ` (${queue.length})` : ''}
    </h2>

    {#if loading}
      <p class="px-1 text-sm text-gray-400">Loading…</p>
    {:else if queue.length === 0}
      <EmptyState title="Nothing to review" description="Reports from players appear here." />
    {:else}
      {#each queue as report (report.id)}
        <div class="overflow-hidden rounded-xl bg-gray-800 text-sm">
          <div class="flex items-start justify-between gap-3 p-4">
            <div class="min-w-0">
              <p class="font-medium text-rose-400">
                {CATEGORY_LABELS[report.category] ?? report.category}
              </p>
              <p class="mt-0.5 text-xs text-gray-400">
                reported {formatRelativeTime(report.created_at)}
              </p>
            </div>
            <span
              class="shrink-0 rounded bg-gray-900 px-2 py-0.5 font-mono text-[10px] text-gray-400"
            >
              #{report.id}
            </span>
          </div>

          <!-- The preview is captured when the report is filed, so it still says what
               was reported after the content has been hidden or deleted. It is another
               player's text: rendered as text, never as markup. -->
          <div class="border-t border-gray-700 px-4 py-3">
            {#if isImagePreview(report.target_preview)}
              <img
                src={report.target_preview}
                alt="Reported content"
                class="max-h-40 rounded-lg object-contain"
              />
            {:else}
              <p class="break-words whitespace-pre-wrap text-gray-200">
                {report.target_preview || '(content unavailable)'}
              </p>
            {/if}
            {#if report.note}
              <p class="mt-2 border-l-2 border-gray-600 pl-2 text-xs text-gray-400">
                {report.note}
              </p>
            {/if}
          </div>

          <div class="grid grid-cols-2 gap-px bg-gray-700">
            <button
              type="button"
              onclick={() => (pendingAction = { report, action: 'dismiss' })}
              class="cursor-pointer bg-gray-800 py-3 font-medium text-gray-300 transition-colors hover:bg-gray-700"
            >
              Dismiss
            </button>
            <button
              type="button"
              onclick={() => (pendingAction = { report, action: 'moderate' })}
              class="cursor-pointer bg-gray-800 py-3 font-medium text-rose-400 transition-colors hover:bg-gray-700"
            >
              Hide content
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</Screen>

{#if pendingAction}
  <ConfirmDialog
    title={pendingAction.action === 'moderate' ? 'Hide this content?' : 'Dismiss this report?'}
    message={pendingAction.action === 'moderate'
      ? 'It disappears for everyone. The audit log keeps a record.'
      : 'The content stays visible and the report is closed.'}
    confirmText={pendingAction.action === 'moderate' ? 'Hide' : 'Dismiss'}
    onconfirm={() => pendingAction && resolve(pendingAction.report, pendingAction.action)}
    oncancel={() => (pendingAction = null)}
  />
{/if}
