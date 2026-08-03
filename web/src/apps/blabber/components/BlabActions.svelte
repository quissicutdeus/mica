<script lang="ts">
  import type { BlabEngagement } from '@shared/types';

  /**
   * Reply / mouth / like, with counts.
   *
   * Counts come from the batched engagement read rather than columns on the Blab — a
   * `like_count` would be a second copy of a fact the likes table already holds, and it drifts
   * the first time something removes a like without decrementing.
   */
  let {
    stats,
    onreply,
    onmouth,
    onlike
  }: {
    stats?: BlabEngagement;
    onreply?: () => void;
    onmouth?: () => void;
    onlike?: () => void;
  } = $props();

  const count = (n?: number) => (n && n > 0 ? String(n) : '');
</script>

<div class="mt-2 flex items-center gap-5 text-xs text-gray-500">
  <button
    type="button"
    class="flex items-center gap-1.5 transition-colors hover:text-sky-400"
    aria-label="Reply"
    onclick={onreply}
  >
    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M8 10.5h8M8 14h5m-5 6.5 3-3h5.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3h-9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3H8v3Z"
      />
    </svg>
    {count(stats?.replies)}
  </button>

  <button
    type="button"
    class="flex items-center gap-1.5 transition-colors hover:text-emerald-400"
    class:text-emerald-400={stats?.mouthedByMe}
    aria-label={stats?.mouthedByMe ? 'Mouthed' : 'Mouth'}
    aria-pressed={stats?.mouthedByMe ?? false}
    onclick={onmouth}
  >
    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M16.5 3.5 20 7l-3.5 3.5M20 7H8a4 4 0 0 0-4 4v1m3.5 8.5L4 17l3.5-3.5M4 17h12a4 4 0 0 0 4-4v-1"
      />
    </svg>
    {count(stats?.mouths)}
  </button>

  <button
    type="button"
    class="flex items-center gap-1.5 transition-colors hover:text-rose-400"
    class:text-rose-400={stats?.likedByMe}
    aria-label={stats?.likedByMe ? 'Unlike' : 'Like'}
    aria-pressed={stats?.likedByMe ?? false}
    onclick={onlike}
  >
    <svg
      class="h-4 w-4"
      viewBox="0 0 24 24"
      fill={stats?.likedByMe ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width="1.5"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M12 20s-7-4.35-7-9.5A4.5 4.5 0 0 1 12 7.8 4.5 4.5 0 0 1 19 10.5c0 5.15-7 9.5-7 9.5Z"
      />
    </svg>
    {count(stats?.likes)}
  </button>
</div>
