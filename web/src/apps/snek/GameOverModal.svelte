<script lang="ts">
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
  <h2 class="text-lg font-semibold">Game Over</h2>
  <p>Score: {score}</p>
  {#if isNewBest}
    <p>New high score!</p>
  {/if}
  <div class="flex gap-2">
    <button type="button" onclick={onrestart}>Play Again</button>
    <button type="button" onclick={onviewleaderboard}>Leaderboard</button>
  </div>
</div>
