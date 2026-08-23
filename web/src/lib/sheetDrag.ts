import { get, type Writable } from 'svelte/store';
import { clampProgress, shouldCommitDrag } from './pointerDrag';

/**
 * The close-drag shared by the two sheets that slide over the phone: the App Drawer and
 * the Notification Shade.
 *
 * They are the same gesture pointed in opposite directions, and they had been written
 * twice — the progress maths, the commit heuristic, the settle-to-0-or-1, and the
 * "never arm on top of a `<button>`" rule, each duplicated with comments in both files
 * explaining that it mirrored the other. Both really do differ in exactly two respects,
 * and the second follows from the first:
 *
 *   - **Which way closing pulls.** The drawer rises from the bottom and closes on a pull
 *     *down*; the shade descends from the top and closes on a pull *up*. That flips the
 *     sign on both the travel and the release velocity, and nothing else.
 *   - **Which scroll edge frees the gesture.** Each sheet contains a list that scrolls on
 *     the same axis, so a body-wide swipe competes with it. They stop competing only when
 *     the list has nothing left to reveal in the direction the close pulls: the drawer's
 *     grid at its *top* (`scrollTop <= 0`), the shade's list at its *bottom*. That is not
 *     an independent knob — it is determined by the direction, so it is derived here
 *     rather than passed in and kept in step by hand.
 */
export type SheetCloseDirection = 'up' | 'down';

export type SheetDragPhase = 'idle' | 'dragging' | 'settling';

export interface SheetCloseOptions {
  /** Which way a closing pull travels. 'up' = shade, 'down' = drawer. */
  direction: SheetCloseDirection;
  /** 0 (closed) .. 1 (open), written continuously while the finger is down. */
  progress: Writable<number>;
  phase: Writable<SheetDragPhase>;
  /** Travel that maps to the full 0..1 range. */
  revealDistance: number;
  /** Called once, on a release that commits. */
  close: () => void;
  /**
   * The sheet's scrolling list, read at gesture time rather than captured: it is a
   * `bind:this` that is null on the first run of the effect that wires this up.
   */
  scrollContainer: () => HTMLElement | null;
}

export interface SheetCloseHandlers {
  onMove: (deltaY: number) => void;
  onEnd: (deltaY: number, velocity: number) => void;
  /** Pass as `shouldStart` when attaching to the sheet body; the handle needs no gate. */
  bodyShouldStart: (e: PointerEvent) => boolean;
}

export function createSheetClose(options: SheetCloseOptions): SheetCloseHandlers {
  const { direction, progress, phase, revealDistance, close, scrollContainer } = options;

  // +1 when closing pulls up, -1 when it pulls down. A pull up produces a negative
  // deltaY, so `1 + sign * deltaY / distance` counts progress back toward 0 either way.
  const sign = direction === 'up' ? 1 : -1;

  const atClosingEdge = (el: HTMLElement): boolean =>
    direction === 'up' ? el.scrollTop + el.clientHeight >= el.scrollHeight - 1 : el.scrollTop <= 0;

  return {
    onMove(deltaY) {
      phase.set('dragging');
      progress.set(clampProgress(1 + (sign * deltaY) / revealDistance));
    },

    onEnd(_deltaY, velocity) {
      phase.set('settling');
      // "Closing progress" is how far back toward 0 the pull got, and closing velocity is
      // the raw axis velocity re-signed so a fast flick reads positive in either
      // direction — `shouldCommitDrag` only ever compares against a positive threshold.
      const closingProgress = 1 - get(progress);
      const closingVelocity = -sign * velocity;
      if (shouldCommitDrag(closingProgress, closingVelocity)) {
        progress.set(0);
        close();
      } else {
        progress.set(1);
      }
    },

    bodyShouldStart(e) {
      // Refuses to arm on top of a `<button>`. The gesture axis-locks on ~4px of
      // movement — well before a tap with a little wobble would read as anything but a
      // click — and once it captures the pointer the click never lands. In the drawer
      // every icon is a button whose own long-press-to-pick-up would be stolen; in the
      // shade it is the per-row clear/archive/restore controls.
      if ((e.target as HTMLElement).closest('button')) return false;
      const el = scrollContainer();
      // No list to compete with: a body drag is unambiguous.
      if (!el) return true;
      return atClosingEdge(el);
    }
  };
}
