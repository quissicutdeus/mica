<script lang="ts">
  import type { Snippet } from 'svelte';
  import { attachDragGesture, shouldCommitSwipe } from '../lib/pointerDrag';

  interface Props {
    /**
     * Fired once the exit animation for a fully-committed swipe finishes — never
     * synchronously at the moment the threshold is crossed. The caller's action
     * (`clearNotifications`/`restoreNotifications`) optimistically removes this row from
     * its keyed `{#each}` list; doing that before the manual CSS exit animation completes
     * would let Svelte tear the DOM node out mid-flight, turning a swipe-off into a
     * visible jump-cut instead of a smooth exit.
     */
    onCommit: () => void;
    children: Snippet;
  }

  let { onCommit, children }: Props = $props();

  let rowRef = $state<HTMLElement | null>(null);
  let offsetX = $state(0);
  let phase = $state<'idle' | 'dragging' | 'settling' | 'exiting'>('idle');

  $effect(() => {
    if (!rowRef) return;
    return attachDragGesture(rowRef, {
      axis: 'x',
      onMove: (dx) => {
        phase = 'dragging';
        offsetX = dx;
      },
      onEnd: (dx, velocity) => {
        const width = rowRef?.offsetWidth ?? 1;
        if (shouldCommitSwipe(dx, width, velocity)) {
          phase = 'exiting';
          offsetX = Math.sign(dx || 1) * width * 1.2;
        } else {
          phase = 'settling';
          offsetX = 0;
        }
      }
    });
  });

  function settle() {
    // Idempotent: a race between the real `transitionend` and the fallback timer below
    // must not call `onCommit` twice, so the first caller flips `phase` away from either
    // terminal state before doing anything else.
    if (phase === 'exiting') {
      phase = 'idle';
      onCommit();
    } else if (phase === 'settling') {
      phase = 'idle';
    }
  }

  function handleTransitionEnd(e: TransitionEvent) {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    settle();
  }

  /**
   * `transitionend` only fires when the transform actually changes value. A swipe
   * dragged well past the commit distance before release can already be resting at (or
   * past) the exit target, or a swipe released almost exactly at 0 can already be resting
   * at the springback target — either way the live drag already painted the value
   * `'exiting'`/`'settling'` sets again, so no transition plays and no event fires. This
   * timer settles anyway, slightly after the CSS duration would have finished; the
   * `$effect` cleanup cancels it whenever the real `transitionend` handles it first.
   */
  $effect(() => {
    if (phase !== 'exiting' && phase !== 'settling') return;
    const timeout = setTimeout(settle, 250);
    return () => clearTimeout(timeout);
  });
</script>

<div
  bind:this={rowRef}
  data-gesture-drag
  class="touch-none {phase === 'dragging' ? '' : 'transition-all duration-200 ease-out'}"
  style="transform: translateX({offsetX}px); opacity: {phase === 'exiting' ? 0 : 1}"
  ontransitionend={handleTransitionEnd}
>
  {@render children()}
</div>
