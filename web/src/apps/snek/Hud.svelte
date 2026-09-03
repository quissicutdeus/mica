<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { useLocale } from '@gos/sdk';

  const { t } = useLocale();

  let { score, highScore, multiplier }: { score: number; highScore: number; multiplier: number } =
    $props();
</script>

<div class="flex items-center justify-between p-2 text-sm">
  <span>{$t('snek.score')} {score}</span>
  <span>x{multiplier}</span>
  <span>{$t('snek.best')} {highScore}</span>
</div>
