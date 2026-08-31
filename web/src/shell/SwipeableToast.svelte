<script lang="ts">
  import type { Snippet } from 'svelte';
  import { attachDragGesture, shouldCommitSwipe } from '../lib/phone/pointerDrag';

  interface Props {
    /** Swipe left or right past the threshold: dismiss the toast and archive its notification. */
    onArchive: () => void;
    /** Swipe up past the threshold: dismiss the toast, leaving its notification active in the drawer. */
    onHide: () => void;
    children: Snippet;
  }

  let { onArchive, onHide, children }: Props = $props();

  let rowRef = $state<HTMLElement | null>(null);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let lockedAxis = $state<'x' | 'y' | null>(null);
  let phase = $state<'idle' | 'dragging' | 'settling' | 'exiting-x' | 'exiting-y'>('idle');

  $effect(() => {
    if (!rowRef) return;
    return attachDragGesture(rowRef, {
      axis: 'xy',
      onAxisLocked: (axis) => {
        lockedAxis = axis;
      },
      onMove: (delta) => {
        phase = 'dragging';
        if (lockedAxis === 'x') {
          offsetX = delta;
        } else {
          // Only upward movement does anything — a downward drag has no action, so the
          // toast does not visually follow it past 0.
          offsetY = Math.min(0, delta);
        }
      },
      onEnd: (delta, velocity) => {
        if (lockedAxis === 'x') {
          const width = rowRef?.offsetWidth ?? 1;
          if (shouldCommitSwipe(delta, width, velocity)) {
            phase = 'exiting-x';
            offsetX = Math.sign(delta || 1) * width * 1.2;
          } else {
            phase = 'settling';
            offsetX = 0;
          }
        } else {
          const height = rowRef?.offsetHeight ?? 1;
          if (delta < 0 && shouldCommitSwipe(delta, height, velocity)) {
            phase = 'exiting-y';
            offsetY = -height * 1.2;
          } else {
            phase = 'settling';
            offsetY = 0;
          }
        }
      }
    });
  });

  function settle() {
    // Idempotent for the same reason as SwipeableRow's: a race between the real
    // `transitionend` and the fallback timer below must not fire the callback twice.
    if (phase === 'exiting-x') {
      phase = 'idle';
      onArchive();
    } else if (phase === 'exiting-y') {
      phase = 'idle';
      onHide();
    } else if (phase === 'settling') {
      phase = 'idle';
      lockedAxis = null;
    }
  }

  function handleTransitionEnd(e: TransitionEvent) {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    settle();
  }

  /** See SwipeableRow's identical comment: an overshoot drag can already rest at the
   * exit/springback target before the phase change, so no transition plays and no event
   * fires. This timer settles anyway, cancelled by the real `transitionend` if it wins. */
  $effect(() => {
    if (phase !== 'exiting-x' && phase !== 'exiting-y' && phase !== 'settling') return;
    const timeout = setTimeout(settle, 250);
    return () => clearTimeout(timeout);
  });
</script>

<div
  bind:this={rowRef}
  data-gesture-drag
  class="touch-none {phase === 'dragging' ? '' : 'duration-medium ease-emphasized transition-all'}"
  style="transform: translate({offsetX}px, {offsetY}px); opacity: {phase === 'exiting-x' ||
  phase === 'exiting-y'
    ? 0
    : 1}"
  ontransitionend={handleTransitionEnd}
>
  {@render children()}
</div>
