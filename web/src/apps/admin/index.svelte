<script lang="ts">
  import {
    Screen,
    EmptyState,
    ConfirmDialog,
    SegmentedControl,
    useAppAction,
    useReports,
    onAppForeground,
    formatRelativeTime,
    type AppProps
  } from '@gphone/sdk';
  import type { Report } from '@shared/types';

  let { onback }: AppProps = $props();

  const { busy, run } = useAppAction('admin');
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
            <div class="bg-surface-container overflow-hidden rounded-xl text-sm">
              <div class="flex items-start justify-between gap-3 p-4">
                <div class="min-w-0">
                  <p class="text-error font-medium">
                    {CATEGORY_LABELS[report.category] ?? report.category}
                  </p>
                  <p class="text-on-surface-variant mt-0.5 text-xs">
                    reported {formatRelativeTime(report.created_at)}
                  </p>
                </div>
                <span
                  class="bg-surface text-on-surface-variant shrink-0 rounded px-2 py-0.5 font-mono text-[10px]"
                >
                  #{report.id}
                </span>
              </div>

              <!-- Captured when the report was filed, so it still says what was reported
                   after the content is gone. Another player's text: rendered as text. -->
              <div class="border-outline-variant border-t px-4 py-3">
                {#if isImage(report.target_preview)}
                  <img
                    src={report.target_preview}
                    alt=""
                    class="max-h-40 rounded-lg object-contain"
                  />
                {:else}
                  <p class="text-on-surface break-words whitespace-pre-wrap">
                    {report.target_preview || '(content unavailable)'}
                  </p>
                {/if}
                {#if report.note}
                  <p class="border-outline text-on-surface-variant mt-2 border-l-2 pl-2 text-xs">
                    {report.note}
                  </p>
                {/if}
              </div>

              <div class="bg-surface-container-high grid grid-cols-2 gap-px">
                <button
                  type="button"
                  disabled={$busy}
                  onclick={() => (confirming = { report, action: 'dismiss' })}
                  class="bg-surface-container text-on-surface hover:bg-surface-container-high duration-short ease-standard cursor-pointer py-3 font-medium transition-colors disabled:opacity-50"
                >
                  Allow — no action
                </button>
                <button
                  type="button"
                  disabled={$busy}
                  onclick={() => (confirming = { report, action: 'moderate' })}
                  class="bg-surface-container text-error hover:bg-surface-container-high duration-short ease-standard cursor-pointer py-3 font-medium transition-colors disabled:opacity-50"
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
          <div class="bg-surface-container overflow-hidden rounded-xl text-sm">
            <div class="flex items-start justify-between gap-3 p-4">
              <div class="min-w-0">
                <p class="text-on-surface font-medium">
                  {CATEGORY_LABELS[report.category] ?? report.category}
                </p>
                <p
                  class="mt-0.5 text-xs {report.resolution === 'actioned'
                    ? 'text-error'
                    : 'text-on-surface-variant'}"
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
                class="border-outline text-on-surface hover:bg-surface-container-high duration-short ease-standard shrink-0 cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              >
                Undo
              </button>
            </div>
            <p
              class="border-outline-variant text-on-surface-variant truncate border-t px-4 py-2 text-xs"
            >
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
