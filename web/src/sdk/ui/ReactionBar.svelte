<script lang="ts">
  import EmojiPicker from './EmojiPicker.svelte';

  /**
   * Grouped reaction counts for one target, plus an "add a reaction" trigger.
   *
   * `counts`/`mine` come from a batched `reactionsFor` read (mirrors `engagement`'s shape) —
   * this component only renders what it is handed and reports taps upward; it holds no state
   * of its own about who reacted with what.
   */
  interface Props {
    counts: Record<string, number>;
    mine: string[];
    onreact: (emoji: string) => void;
    onunreact: (emoji: string) => void;
    class?: string;
  }

  let { counts, mine, onreact, onunreact, class: className = '' }: Props = $props();

  const entries = $derived(
    Object.entries(counts)
      .filter(([, total]) => total > 0)
      .sort((a, b) => b[1] - a[1])
  );

  const toggle = (emoji: string) => {
    if (mine.includes(emoji)) onunreact(emoji);
    else onreact(emoji);
  };
</script>

<div class="flex flex-wrap items-center gap-1 {className}">
  {#each entries as [emoji, total] (emoji)}
    {@const isMine = mine.includes(emoji)}
    <button
      type="button"
      class="text-body-small flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 transition-colors {isMine
        ? 'bg-primary-container border-primary text-on-primary-container'
        : 'bg-surface-container border-outline-variant text-on-surface-variant hover:border-outline'} duration-short ease-standard"
      onclick={() => toggle(emoji)}
      aria-pressed={isMine}
      aria-label="{emoji} reaction, {total}, {isMine ? 'tap to remove yours' : 'tap to add yours'}"
    >
      <span>{emoji}</span>
      <span>{total}</span>
    </button>
  {/each}
  <EmojiPicker onselect={onreact} class="scale-90" />
</div>
