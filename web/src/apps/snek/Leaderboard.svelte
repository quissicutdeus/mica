<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { useHighscores, useLocale, EmptyState } from '@mica/sdk';
  import type { LeaderboardEntry } from '@mica/shared/types';

  let { onback }: { onback: () => void } = $props();

  const { getLeaderboard } = useHighscores();
  const { t } = useLocale();
  let entries = $state<LeaderboardEntry[]>([]);
  let loaded = $state(false);

  $effect(() => {
    getLeaderboard('snek').then((rows) => {
      entries = rows;
      loaded = true;
    });
  });
</script>

<div class="flex flex-col gap-2 p-4">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-semibold">{$t('snek.leaderboard')}</h2>
    <button type="button" onclick={onback}>{$t('snek.back')}</button>
  </div>
  {#if loaded && entries.length === 0}
    <EmptyState title={$t('snek.noScores')} description={$t('snek.noScoresHint')} />
  {:else}
    <ol class="flex flex-col gap-1">
      {#each entries as entry, i (entry.citizenid)}
        <li class="flex justify-between">
          <span>{i + 1}. {entry.displayName ?? $t('snek.unknown')}</span>
          <span>{entry.score}</span>
        </li>
      {/each}
    </ol>
  {/if}
</div>
