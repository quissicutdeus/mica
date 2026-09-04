<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { useLocale } from '@mica/sdk';

  const { t } = useLocale();

  let {
    score,
    highScore,
    onrestart,
    onviewleaderboard
  }: {
    score: number;
    highScore: number;
    onrestart: () => void;
    onviewleaderboard: () => void;
  } = $props();

  const isNewBest = $derived(score >= highScore && score > 0);
</script>

<div class="flex flex-col items-center gap-4 p-6">
  <h2 class="text-lg font-semibold">{$t('snek.gameOver')}</h2>
  <p>{$t('snek.score')} {score}</p>
  {#if isNewBest}
    <p>{$t('snek.newHighScore')}</p>
  {/if}
  <div class="flex gap-2">
    <button type="button" onclick={onrestart}>{$t('snek.playAgain')}</button>
    <button type="button" onclick={onviewleaderboard}>{$t('snek.leaderboard')}</button>
  </div>
</div>
