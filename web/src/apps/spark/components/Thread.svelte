<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { DmThread, EmptyState, ReportDialog, useLocale, type DirectMessage } from '@mica/sdk';
  import type { SparkMatch } from '@mica/shared/types';
  import { LIMITS, loadThreads } from '../store';

  /**
   * One match's thread: the SDK's `DmThread` (MICA-392), as my Spark account with the match's.
   *
   * The thread owns its paging, its read marker, the push merge and the send. What stays here
   * is Spark's: the composer's hint names the match, and Report files against
   * `mica_blabber_dms`, the table `dms` keeps. Every read or write in the thread refreshes the
   * inbox, which is where the matches list and the badge take their last lines and unread.
   */
  let {
    match,
    accountId
  }: {
    match: SparkMatch;
    /** My Spark account, `profile.account_id`. */
    accountId: number;
  } = $props();

  const { t } = useLocale();

  let reporting = $state<number | null>(null);

  const name = $derived(match.profile.display_name || $t('spark.someone'));
</script>

{#snippet empty()}
  <EmptyState title={$t('spark.nothingYet')} description={$t('spark.nothingYetHint')} />
{/snippet}

<DmThread
  appId="spark"
  {accountId}
  peerAccountId={match.profile.account_id}
  bodyMax={LIMITS.message}
  placeholder={$t('spark.messagePlaceholder', { name })}
  {empty}
  onreport={(message: DirectMessage) => (reporting = message.id)}
  onactivity={() => void loadThreads()}
/>

{#if reporting !== null}
  <ReportDialog
    targetTable="mica_blabber_dms"
    targetId={reporting}
    appId="spark"
    onclose={() => (reporting = null)}
  />
{/if}
