<script lang="ts">
  import type { GameState, Direction } from './game';

  let { state, onmove }: { state: GameState; onmove: (dir: Direction) => void } = $props();

  const KEY_TO_DIRECTION: Record<string, Direction> = {
    w: 'up',
    a: 'left',
    s: 'down',
    d: 'right'
  };

  const onkeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const direction = KEY_TO_DIRECTION[event.key.toLowerCase()];
    if (!direction) return;
    event.preventDefault();
    onmove(direction);
  };

  const cellKey = (x: number, y: number) => `${x}:${y}`;
  const snakeCells = $derived(new Set(state.snake.map((p) => cellKey(p.x, p.y))));
</script>

<svelte:window {onkeydown} />

<div
  class="grid gap-px"
  style="grid-template-columns: repeat({state.grid.width}, 1fr); aspect-ratio: {state.grid
    .width} / {state.grid.height};"
>
  {#each Array(state.grid.height) as _, y (y)}
    {#each Array(state.grid.width) as _, x (x)}
      {@const key = cellKey(x, y)}
      {@const isHead = state.snake[0].x === x && state.snake[0].y === y}
      {@const isSnake = snakeCells.has(key)}
      {@const isFood = state.food.x === x && state.food.y === y}
      <div
        class="aspect-square"
        class:bg-yellow-500={isHead}
        class:bg-yellow-600={isSnake && !isHead}
        class:bg-red-500={isFood}
        class:bg-surface-container-low={!isSnake && !isFood}
      ></div>
    {/each}
  {/each}
</div>
