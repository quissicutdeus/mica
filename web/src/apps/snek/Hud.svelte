<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  let { score, highScore, multiplier }: { score: number; highScore: number; multiplier: number } =
    $props();
</script>

<div class="flex items-center justify-between p-2 text-sm">
  <span>Score: {score}</span>
  <span>x{multiplier}</span>
  <span>Best: {highScore}</span>
</div>
