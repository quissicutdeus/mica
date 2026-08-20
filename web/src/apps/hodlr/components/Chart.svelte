<script lang="ts">
  import type { PricePoint } from '@shared/types';

  let { history }: { history: PricePoint[] } = $props();

  const WIDTH = 300;
  const HEIGHT = 80;

  const points = $derived.by(() => {
    const prices = history.map((p) => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;

    return history
      .map((point, i) => {
        const x = (i / (history.length - 1)) * WIDTH;
        const y = HEIGHT - ((point.price - min) / range) * HEIGHT;
        return `${x},${y}`;
      })
      .join(' ');
  });

  const trendUp = $derived(history[history.length - 1].price >= history[0].price);
</script>

<div class="bg-surface-container rounded-xl p-4">
  <svg viewBox="0 0 {WIDTH} {HEIGHT}" class="h-20 w-full" preserveAspectRatio="none">
    <polyline
      {points}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      class={trendUp ? 'text-emerald-400' : 'text-red-400'}
    />
  </svg>
</div>
