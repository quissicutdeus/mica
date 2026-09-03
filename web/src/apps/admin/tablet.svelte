<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Screen,
    EmptyState,
    SegmentedControl,
    useAppAction,
    useLocale,
    registerMessages,
    useReports,
    onAppForeground,
    formatRelativeTime,
    type AppProps
  } from '@gphone/sdk';
  import type { Report } from '@gphone/shared/types';
  import en from './locales/en.json';
  import de from './locales/de.json';
  import ReportPreview from './components/ReportPreview.svelte';
  import ResolveDialog from './components/ResolveDialog.svelte';
  import { CATEGORY_KEYS, RESOLUTION_KEYS, type ResolveAction } from './components/labels';

  // The same catalog as the phone root: one app, two layouts, never two wordings.
  registerMessages('admin', { en, de });
  const { t } = useLocale();

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
  let confirming = $state<{ report: Report; action: ResolveAction } | null>(null);

  onAppForeground('admin', () => {
    void loadPendingReports();
    void loadReportHistory();
  });

  const rows = $derived(tab === 'pending' ? $pendingReports : $resolvedReports);

  /**
   * Which report the detail pane is showing.
   *
   * The queue is not a static list — a decision takes its row out from under the cursor,
   * and an undo puts one back — so the selection is held by id and repaired whenever the
   * list changes. `at` remembers where the selection sat, so the row that closes is
   * replaced by the one that slid into its place rather than by the top of the list: on a
   * queue of forty, being thrown back to the first report after every decision is what
   * makes a wide screen worse than a narrow one.
   */
  let selectedId = $state<number | null>(null);
  let at = $state(0);

  $effect(() => {
    if (rows.length === 0) {
      selectedId = null;
      return;
    }
    const index = rows.findIndex((report) => report.id === selectedId);
    if (index >= 0) {
      at = index;
      return;
    }
    selectedId = rows[Math.min(at, rows.length - 1)].id;
  });

  const selected = $derived(rows.find((report) => report.id === selectedId) ?? null);

  const select = (report: Report) => {
    selectedId = report.id;
  };

  const switchTab = (id: string) => {
    tab = id as Tab;
    // A fresh tab is a fresh list; start at its top rather than at the other tab's index.
    at = 0;
    selectedId = null;
  };

  const labelFor = (report: Report) =>
    CATEGORY_KEYS[report.category] ? $t(CATEGORY_KEYS[report.category]) : report.category;

  const resolutionFor = (report: Report) =>
    RESOLUTION_KEYS[report.resolution] ? $t(RESOLUTION_KEYS[report.resolution]) : report.resolution;

  /** Every decision closes its confirmation, whether or not the server agreed. */
  const decide = async (report: Report, action: ResolveAction, success: string) => {
    await run(() => resolveReport(report.id, action), { success });
    confirming = null;
  };
</script>

<Screen title={$t('admin.title')} {onback}>
  <div class="flex min-h-0 flex-1">
    <!-- The queue. A third of the 1280px frame is a little over 420px, which is about a
         phone's width — the list is the same list, just permanently on screen. -->
    <div class="border-outline-variant flex min-h-0 w-1/3 shrink-0 flex-col border-r">
      <div class="p-4">
        <SegmentedControl
          aria-label={$t('admin.queue')}
          selected={tab}
          onchange={switchTab}
          options={[
            { id: 'pending', label: $t('admin.pending'), badge: $pendingReports.length },
            { id: 'history', label: $t('admin.history') }
          ]}
        />
      </div>

      <div class="flex-1 overflow-y-auto px-4 pb-4">
        {#if rows.length === 0}
          <EmptyState
            title={tab === 'pending' ? $t('admin.nothingToReview') : $t('admin.noHistory')}
            description={tab === 'pending'
              ? $t('admin.nothingToReviewHint')
              : $t('admin.noHistoryHint')}
          />
        {:else}
          <div class="space-y-2">
            {#each rows as report (report.id)}
              <button
                type="button"
                aria-pressed={report.id === selectedId}
                onclick={() => select(report)}
                class="hover:bg-surface-container-high duration-short ease-standard w-full cursor-pointer rounded-box px-4 py-3 text-left transition-colors {report.id ===
                selectedId
                  ? 'bg-surface-container-high'
                  : 'bg-surface-container'}"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p
                      class="text-body-medium truncate font-medium {tab === 'pending'
                        ? 'text-error'
                        : 'text-on-surface'}"
                    >
                      {labelFor(report)}
                    </p>
                    <p class="text-on-surface-variant text-body-small mt-0.5">
                      {tab === 'pending'
                        ? $t('admin.reported', { when: formatRelativeTime(report.created_at) })
                        : `${resolutionFor(report)} · ${formatRelativeTime(report.updated_at)}`}
                    </p>
                  </div>
                  <span
                    class="bg-surface text-on-surface-variant text-label-small shrink-0 rounded-chip px-2 py-0.5 font-mono"
                  >
                    #{report.id}
                  </span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <!-- The decision. -->
    <div data-testid="admin-detail" class="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
      {#if !selected}
        <EmptyState title={$t('admin.selectReport')} description={$t('admin.selectReportHint')} />
      {:else}
        {@const report = selected}
        <div class="space-y-4">
          <div class="bg-surface-container text-body-medium rounded-box p-4">
            <ReportPreview preview={report.target_preview} note={report.note} />
          </div>

          <div class="space-y-1">
            <p
              class="text-title-medium font-medium {tab === 'pending'
                ? 'text-error'
                : 'text-on-surface'}"
            >
              {labelFor(report)}
            </p>
            <p class="text-on-surface-variant text-body-small">
              {$t('admin.reporter')}: {report.target_author || `#${report.id}`}
            </p>
            <p class="text-on-surface-variant text-body-small">
              {tab === 'pending'
                ? $t('admin.reported', { when: formatRelativeTime(report.created_at) })
                : `${resolutionFor(report)} · ${formatRelativeTime(report.updated_at)}`}
            </p>
          </div>

          {#if tab === 'pending'}
            <div class="flex gap-3">
              <button
                type="button"
                disabled={$busy}
                onclick={() => (confirming = { report, action: 'dismiss' })}
                class="bg-surface-container text-on-surface hover:bg-surface-container-high duration-short ease-standard flex-1 cursor-pointer rounded-box py-3 font-medium transition-colors disabled:opacity-50"
              >
                {$t('admin.allow')}
              </button>
              <button
                type="button"
                disabled={$busy}
                onclick={() => (confirming = { report, action: 'moderate' })}
                class="bg-surface-container text-error hover:bg-surface-container-high duration-short ease-standard flex-1 cursor-pointer rounded-box py-3 font-medium transition-colors disabled:opacity-50"
              >
                {$t('admin.removeForEveryone')}
              </button>
            </div>
          {:else}
            <button
              type="button"
              disabled={$busy}
              onclick={() => run(() => reopenReport(report.id), { success: $t('admin.reopened') })}
              class="border-outline text-on-surface hover:bg-surface-container-high duration-short ease-standard text-body-small cursor-pointer rounded-box border px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              {$t('admin.undo')}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</Screen>

{#if confirming}
  <ResolveDialog pending={confirming} onconfirm={decide} oncancel={() => (confirming = null)} />
{/if}
