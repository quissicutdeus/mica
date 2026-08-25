import { get, type Writable } from 'svelte/store';
import { clampProgress, shouldCommitDrag, type CommitDragOptions } from './pointerDrag';

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

/**
 * What counts as "open it" for the App Drawer's swipe-up.
 *
 * The default `shouldCommitDrag` thresholds are the shade's, and they are right there: the
 * shade is pulled *down* from the status bar, which is a long, deliberate travel anyway.
 * Applied to the drawer they were not — with `revealDistance` at the full 850px phone
 * height, committing at 0.5 meant swiping up 425px, half the phone, from a 24px bar at the
 * very bottom edge. The velocity escape hatch did not rescue it either: `measureDragRatio`
 * divides the delta by the phone's zoom, so on a display large enough to scale the phone
 * *up* — an ultrawide, where it fits at ~1.7x — 1.2 design-px/ms is nearer 2000 real px/s.
 * The gesture was reachable in principle and almost never in practice.
 *
 * Lowering `revealDistance` instead would have been the wrong knob: `AppDrawer.svelte`
 * maps this same progress onto a fixed 850px `translateY`, so a shorter reveal distance
 * makes the sheet outrun the finger. Thresholds change what counts as intent; the sheet
 * still tracks the finger 1:1 the whole way.
 */
export const DRAWER_OPEN_COMMIT: CommitDragOptions = {
  progressThreshold: 0.2,
  velocityThreshold: 0.6
};

export interface SheetOpenOptions {
  /** Which way an opening pull travels. 'up' = drawer (rises from the bottom). */
  direction: SheetCloseDirection;
  progress: Writable<number>;
  phase: Writable<SheetDragPhase>;
  revealDistance: number;
  /** Checked before every move/end — a drag starting while already open, or from the
   * wrong screen, is a no-op rather than fighting whatever else owns the sheet. */
  guard: () => boolean;
  /** Called once, on a release that commits. */
  open: () => void;
  /** Overrides the commit thresholds. Defaults to the shade's; the drawer passes `DRAWER_OPEN_COMMIT`. */
  commit?: CommitDragOptions;
}

export interface SheetOpenHandlers {
  onMove: (deltaY: number) => void;
  onEnd: (deltaY: number, velocity: number) => void;
}

/** Open-drag counterpart to `createSheetClose`. Shared by the Dock, the home indicator
 * bar, and the collapsed search bar (MICA-45/46) so the swipe-up-to-open math lives once. */
export function createSheetOpen(options: SheetOpenOptions): SheetOpenHandlers {
  const { direction, progress, phase, revealDistance, guard, open, commit } = options;
  const sign = direction === 'up' ? -1 : 1;

  return {
    onMove(deltaY) {
      if (!guard()) return;
      phase.set('dragging');
      progress.set(clampProgress((sign * deltaY) / revealDistance));
    },
    onEnd(_deltaY, velocity) {
      if (!guard()) return;
      phase.set('settling');
      if (shouldCommitDrag(get(progress), sign * velocity, commit)) {
        progress.set(1);
        open();
      } else {
        progress.set(0);
      }
    }
  };
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
