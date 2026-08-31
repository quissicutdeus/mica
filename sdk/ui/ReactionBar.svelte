<script lang="ts">
  import type { ReactionSummary } from '@shared/types';
  import EmojiPicker from './EmojiPicker.svelte';
  import { NO_REACTIONS } from '../kit/createReactionStore';

  /**
   * Grouped reaction counts for one target, plus an "add a reaction" trigger.
   *
   * The render half of the reactions primitive (MICA-98); `createReactionStore` is the
   * other. This component holds no state about who reacted with what — it draws the summary
   * it is handed and reports taps upward.
   *
   * `summary` is the whole `ReactionSummary` rather than a `counts`/`mine` pair, because that
   * is exactly what `$reactions[targetId]` is, and defaulting it here saves every call site an
   * `?? {}` / `?? []`.
   *
   * **One verb, not two.** It used to take `onreact` and `onunreact`, and its only consumer
   * handed the same toggling function to both — the split asked the caller to re-derive a
   * decision this component had already made from `mine`. A reaction is a toggle everywhere it
   * appears, including from the picker: choosing an emoji already yours takes it back, which is
   * what tapping its chip does.
   */
  interface Props {
    summary?: ReactionSummary | null;
    ontoggle: (emoji: string) => void;
    class?: string;
  }

  let { summary = null, ontoggle, class: className = '' }: Props = $props();

  const mine = $derived(summary?.mine ?? NO_REACTIONS.mine);

  /**
   * Busiest first, ties broken by the emoji itself.
   *
   * The tiebreak is not cosmetic: without it two reactions on the same count sit in whatever
   * order the server's object happened to enumerate, so a refetch can reorder chips under the
   * player's thumb between the press and the release.
   */
  const entries = $derived(
    Object.entries(summary?.counts ?? NO_REACTIONS.counts)
      .filter(([, total]) => total > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
</script>

<div class="flex flex-wrap items-center gap-1 {className}">
  {#each entries as [emoji, total] (emoji)}
    {@const isMine = mine.includes(emoji)}
    <button
      type="button"
      class="text-body-small flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 transition-colors {isMine
        ? 'bg-primary-container border-primary text-on-primary-container'
        : 'bg-surface-container border-outline-variant text-on-surface-variant hover:border-outline'} duration-short ease-standard"
      onclick={() => ontoggle(emoji)}
      aria-pressed={isMine}
      aria-label="{emoji} reaction, {total}, {isMine ? 'tap to remove yours' : 'tap to add yours'}"
    >
      <span>{emoji}</span>
      <span>{total}</span>
    </button>
  {/each}
  <EmojiPicker onselect={ontoggle} class="scale-90" />
</div>
