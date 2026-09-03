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
    type AppProps
  } from '@gos/sdk';
  import type { Report } from '@gos/shared/types';
  import en from './locales/en.json';
  import de from './locales/de.json';
  import PendingReportCard from './components/PendingReportCard.svelte';
  import HistoryRow from './components/HistoryRow.svelte';
  import ResolveDialog from './components/ResolveDialog.svelte';
  import type { ResolveAction } from './components/labels';

  // MICA-215: the moderation queue reads its strings out of a catalog like every other
  // app, so a server whose admins do not read English is not stuck with this screen.
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

  // Refreshed on every visit: reports are filed by other players and nothing pushes
  // them here, so a queue fetched once at open would be stale the moment it mattered.
  onAppForeground('admin', () => {
    void loadPendingReports();
    void loadReportHistory();
  });

  /** Every decision closes its confirmation, whether or not the server agreed. */
  const decide = async (report: Report, action: ResolveAction, success: string) => {
    await run(() => resolveReport(report.id, action), { success });
    confirming = null;
  };
</script>

<Screen title={$t('admin.title')} {onback}>
  <div class="p-4">
    <!-- Two tabs, matching Mail and Messages, so a decision can be reviewed and undone
         rather than being final the moment it is made. -->
    <div class="mb-4">
      <SegmentedControl
        aria-label={$t('admin.queue')}
        selected={tab}
        onchange={(id) => (tab = id as Tab)}
        options={[
          { id: 'pending', label: $t('admin.pending'), badge: $pendingReports.length },
          { id: 'history', label: $t('admin.history') }
        ]}
      />
    </div>

    {#if tab === 'pending'}
      {#if $pendingReports.length === 0}
        <EmptyState
          title={$t('admin.nothingToReview')}
          description={$t('admin.nothingToReviewHint')}
        />
      {:else}
        <div class="space-y-4">
          {#each $pendingReports as report (report.id)}
            <PendingReportCard
              {report}
              busy={$busy}
              onallow={() => (confirming = { report, action: 'dismiss' })}
              onremove={() => (confirming = { report, action: 'moderate' })}
            />
          {/each}
        </div>
      {/if}
    {:else if $resolvedReports.length === 0}
      <EmptyState title={$t('admin.noHistory')} description={$t('admin.noHistoryHint')} />
    {:else}
      <div class="space-y-3">
        {#each $resolvedReports as report (report.id)}
          <HistoryRow
            {report}
            busy={$busy}
            onundo={() => run(() => reopenReport(report.id), { success: $t('admin.reopened') })}
          />
        {/each}
      </div>
    {/if}
  </div>
</Screen>

{#if confirming}
  <ResolveDialog pending={confirming} onconfirm={decide} oncancel={() => (confirming = null)} />
{/if}
