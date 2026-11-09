<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { tick } from 'svelte';
  import type { ReactionSummary } from '@mica/shared/types';
  import EmojiPicker from './EmojiPicker.svelte';
  import { NO_REACTIONS } from '../kit/createReactionStore';
  import { t } from '../i18n';
  import './messages';

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

  /**
   * The picker mounts on first open, not with the bar (MICA-448).
   *
   * Every message bubble draws a `ReactionBar`, and an always-mounted `EmojiPicker` put
   * seven buttons in each — six of them colour emoji, whose first shaping walks the font
   * fallback chain. A 50-row thread paid ~110 ms of layout and ~40 ms of script for a
   * palette almost nobody touches. Until the player asks, the bar draws one "+" button in
   * the picker's own look, labelled "Add reaction" (`ui.addReaction`); pressing it mounts `EmojiPicker` in its place,
   * and from then on the bar is exactly what it always was. It never folds back: a bar the
   * player has reached for stays the way they left it.
   *
   * The trigger is removed by the press that opens the picker, so focus moves to the
   * picker's first button rather than falling to `<body>` — a keyboard user lands on the
   * palette they just asked for.
   */
  let open = $state(false);
  let bar = $state<HTMLElement>();

  const openPicker = async () => {
    open = true;
    await tick();
    // The chips are the bar's own buttons; the picker's are inside its root `div`.
    bar?.querySelector<HTMLButtonElement>(':scope > div button')?.focus();
  };
</script>

<div class="flex flex-wrap items-center gap-1 {className}" bind:this={bar}>
  {#each entries as [emoji, total] (emoji)}
    {@const isMine = mine.includes(emoji)}
    <button
      type="button"
      class="text-body-small flex cursor-pointer items-center gap-1 rounded-chip border px-2 py-0.5 transition-colors {isMine
        ? 'bg-primary-container border-primary text-on-primary-container'
        : 'bg-surface-container border-outline-variant text-on-surface-variant hover:border-outline'} duration-short ease-standard"
      onclick={() => ontoggle(emoji)}
      aria-pressed={isMine}
      aria-label={$t('ui.reaction', {
        emoji,
        total,
        action: isMine ? $t('ui.tapToRemoveReaction') : $t('ui.tapToAddReaction')
      })}
    >
      <span>{emoji}</span>
      <span>{total}</span>
    </button>
  {/each}
  {#if open}
    <EmojiPicker onselect={ontoggle} class="scale-90" />
  {:else}
    <button
      type="button"
      class="text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface duration-short ease-standard flex h-8 w-8 scale-90 cursor-pointer items-center justify-center rounded-full text-lg transition-colors"
      onclick={openPicker}
      aria-label={$t('ui.addReaction')}
      aria-expanded="false"
    >
      +
    </button>
  {/if}
</div>
