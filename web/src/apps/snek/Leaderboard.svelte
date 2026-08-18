<script lang="ts">
  import { useHighscores, EmptyState } from '@gphone/sdk';
  import type { LeaderboardEntry } from '@shared/types';

  let { onback }: { onback: () => void } = $props();

  const { getLeaderboard } = useHighscores();
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
    <h2 class="text-lg font-semibold">Leaderboard</h2>
    <button type="button" onclick={onback}>Back</button>
  </div>
  {#if loaded && entries.length === 0}
    <EmptyState title="No scores yet" description="Be the first to play." />
  {:else}
    <ol class="flex flex-col gap-1">
      {#each entries as entry, i (entry.citizenid)}
        <li class="flex justify-between">
          <span>{i + 1}. {entry.displayName ?? 'Unknown'}</span>
          <span>{entry.score}</span>
        </li>
      {/each}
    </ol>
  {/if}
</div>
