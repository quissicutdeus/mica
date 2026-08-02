<script lang="ts">
  import {
    Screen,
    EmptyState,
    ConfirmDialog,
    SegmentedControl,
    useAppAction,
    useReports,
    onAppForeground,
    formatRelativeTime
  } from '@gphone/sdk';
  import type { Report } from '@shared/types';

  let { onback } = $props<{ onback?: () => void }>();

  const { busy, run } = useAppAction();
  const {
    pendingReports,
    resolvedReports,
    loadPendingReports,
    loadReportHistory,
    resolveReport,
    reopenReport
  } = useReports();

  type Tab = 'pending' | 'history';
  let tab = $state<Tab>('pending');
  let confirming = $state<{ report: Report; action: 'moderate' | 'dismiss' } | null>(null);

  const CATEGORY_LABELS: Record<string, string> = {
    spam: 'Spam',
    harassment: 'Harassment',
    threats: 'Threats or violence',
    sexual: 'Sexual content',
    impersonation: 'Impersonation',
    other: 'Other'
  };

  const RESOLUTION_LABELS: Record<string, string> = {
    actioned: 'Content removed',
    dismissed: 'No action taken'
  };

  // Refreshed on every visit: reports are filed by other players and nothing pushes
  // them here, so a queue fetched once at open would be stale the moment it mattered.
  onAppForeground('admin', () => {
    void loadPendingReports();
    void loadReportHistory();
  });

  /** Every decision closes its confirmation, whether or not the server agreed. */
  const decide = async (work: () => Promise<void>, success: string) => {
    await run(work, { success });
    confirming = null;
  };

  /** A photo's stored preview is a base64 data URI; anything else is text. */
  const isImage = (preview?: string) => Boolean(preview?.startsWith('data:image'));
</script>

<Screen title="Admin" {onback}>
  <div class="p-4">
    <!-- Two tabs, matching Mail and Messages, so a decision can be reviewed and undone
         rather than being final the moment it is made. -->
    <div class="mb-4">
      <SegmentedControl
        aria-label="Report queue"
        selected={tab}
        onchange={(id) => (tab = id as Tab)}
        options={[
          { id: 'pending', label: 'Pending', badge: $pendingReports.length },
          { id: 'history', label: 'History' }
        ]}
      />
    </div>

    {#if tab === 'pending'}
      {#if $pendingReports.length === 0}
        <EmptyState title="Nothing to review" description="Reports from players appear here." />
      {:else}
        <div class="space-y-4">
          {#each $pendingReports as report (report.id)}
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

              <!-- Captured when the report was filed, so it still says what was reported
                   after the content is gone. Another player's text: rendered as text. -->
              <div class="border-t border-gray-700 px-4 py-3">
                {#if isImage(report.target_preview)}
                  <img
                    src={report.target_preview}
                    alt=""
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
                  disabled={$busy}
                  onclick={() => (confirming = { report, action: 'dismiss' })}
                  class="cursor-pointer bg-gray-800 py-3 font-medium text-gray-300 transition-colors hover:bg-gray-700 disabled:opacity-50"
                >
                  Allow — no action
                </button>
                <button
                  type="button"
                  disabled={$busy}
                  onclick={() => (confirming = { report, action: 'moderate' })}
                  class="cursor-pointer bg-gray-800 py-3 font-medium text-rose-400 transition-colors hover:bg-gray-700 disabled:opacity-50"
                >
                  Remove for everyone
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if $resolvedReports.length === 0}
      <EmptyState title="No history yet" description="Decisions you make appear here." />
    {:else}
      <div class="space-y-3">
        {#each $resolvedReports as report (report.id)}
          <div class="overflow-hidden rounded-xl bg-gray-800 text-sm">
            <div class="flex items-start justify-between gap-3 p-4">
              <div class="min-w-0">
                <p class="font-medium text-gray-200">
                  {CATEGORY_LABELS[report.category] ?? report.category}
                </p>
                <p
                  class="mt-0.5 text-xs {report.resolution === 'actioned'
                    ? 'text-rose-400'
                    : 'text-gray-400'}"
                >
                  {RESOLUTION_LABELS[report.resolution] ?? report.resolution} ·
                  {formatRelativeTime(report.updated_at)}
                </p>
              </div>
              <button
                type="button"
                disabled={$busy}
                onclick={() =>
                  run(() => reopenReport(report.id), {
                    success: 'Reopened — content restored if it was removed'
                  })}
                class="shrink-0 cursor-pointer rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-gray-700 disabled:opacity-50"
              >
                Undo
              </button>
            </div>
            <p class="truncate border-t border-gray-700 px-4 py-2 text-xs text-gray-400">
              {isImage(report.target_preview) ? '(photo)' : report.target_preview || '—'}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</Screen>

{#if confirming}
  <ConfirmDialog
    title={confirming.action === 'moderate' ? 'Remove this content?' : 'Leave this content up?'}
    message={confirming.action === 'moderate'
      ? 'It disappears for everyone who could see it. You can undo this from History.'
      : 'The content stays visible and the report is closed. You can undo this from History.'}
    confirmText={confirming.action === 'moderate' ? 'Remove' : 'Allow'}
    confirmVariant={confirming.action === 'moderate' ? 'danger' : 'primary'}
    onconfirm={() =>
      confirming &&
      decide(
        () => resolveReport(confirming!.report.id, confirming!.action),
        confirming!.action === 'moderate' ? 'Content removed' : 'Report closed'
      )}
    oncancel={() => (confirming = null)}
  />
{/if}
