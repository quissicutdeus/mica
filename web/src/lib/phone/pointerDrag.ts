// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { measureDragRatio } from './dragRatio';

/**
 * Which axis, if either, a drag has committed to.
 *
 * Returns `null` until either delta crosses `threshold`, so a gesture consumer never has
 * to guess an axis from a single noisy sample. Once past threshold, the larger absolute
 * delta wins — a tie resolves to `'x'`, an arbitrary but deterministic choice since a
 * true tie between two pixel deltas is vanishingly rare in practice.
 */
export function lockAxis(deltaX: number, deltaY: number, threshold: number): 'x' | 'y' | null {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (absX < threshold && absY < threshold) return null;
  return absX >= absY ? 'x' : 'y';
}

/** Clamp a progress value into `[0, 1]`. */
export function clampProgress(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export interface VelocityTracker {
  record(value: number, timeMs: number): void;
  /** Signed units-per-millisecond over roughly the last `windowMs`. 0 with fewer than two samples. */
  velocityPerMs(): number;
}

const DEFAULT_VELOCITY_WINDOW_MS = 50;

/**
 * A rolling-window velocity estimate for a dragged value.
 *
 * Only the samples within the last `windowMs` are kept, so a fast flick right before
 * release is what determines "how fast", not the average speed of the entire gesture —
 * a slow drag that ends in a fast flick should read as a flick.
 */
export function createVelocityTracker(
  windowMs: number = DEFAULT_VELOCITY_WINDOW_MS
): VelocityTracker {
  const samples: { value: number; timeMs: number }[] = [];
  return {
    record(value, timeMs) {
      samples.push({ value, timeMs });
      const cutoff = timeMs - windowMs;
      while (samples.length > 1 && samples[0].timeMs < cutoff) {
        samples.shift();
      }
    },
    velocityPerMs() {
      if (samples.length < 2) return 0;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.timeMs - first.timeMs;
      if (dt <= 0) return 0;
      return (last.value - first.value) / dt;
    }
  };
}

export interface CommitDragOptions {
  /** Fraction of the drag's full travel past which release commits regardless of speed. Default 0.5. */
  progressThreshold?: number;
  /** Units-per-ms past which a fast release commits even below `progressThreshold`. Default 1.2. */
  velocityThreshold?: number;
}

/** Should a progress-based drag (the shade opening/closing) commit, or spring back? */
export function shouldCommitDrag(
  progress: number,
  velocityPerMs: number,
  opts: CommitDragOptions = {}
): boolean {
  const { progressThreshold = 0.5, velocityThreshold = 1.2 } = opts;
  if (progress >= progressThreshold) return true;
  return velocityPerMs >= velocityThreshold;
}

export interface CommitSwipeOptions {
  /** Fraction of the row's width past which release commits regardless of speed. Default 0.4. */
  distanceFraction?: number;
  /** Px-per-ms past which a fast flick commits even below `distanceFraction`. Default 0.5. */
  velocityThreshold?: number;
  /** A flick below this many px never commits on velocity alone, guarding against an accidental jerk. Default 24. */
  minFlickDistance?: number;
}

/** Should a horizontal row swipe commit to clear/restore, or spring back? */
export function shouldCommitSwipe(
  offsetPx: number,
  containerWidthPx: number,
  velocityPxPerMs: number,
  opts: CommitSwipeOptions = {}
): boolean {
  const { distanceFraction = 0.4, velocityThreshold = 0.5, minFlickDistance = 24 } = opts;
  const distance = Math.abs(offsetPx);
  if (containerWidthPx > 0 && distance >= containerWidthPx * distanceFraction) return true;
  return distance >= minFlickDistance && Math.abs(velocityPxPerMs) >= velocityThreshold;
}

export interface DragGestureConfig {
  /**
   * `'x'`/`'y'` pin the gesture to one axis — movement that locks to the other axis
   * cancels (see `onCancel`). `'xy'` accepts either: whichever axis the movement first
   * locks to becomes the gesture's axis for the rest of the drag.
   */
  axis: 'x' | 'y' | 'xy';
  /** Px of raw (uncorrected) movement before the gesture commits to an axis. Default 4, matching dragScroll.ts. */
  axisThreshold?: number;
  /** Swallow the next `click` once a real drag has committed, so drag-release doesn't also fire a tap handler. Default true. */
  suppressClickAfterDrag?: boolean;
  /**
   * Raw px of peak travel a gesture must reach before its release is allowed to swallow
   * the following `click`. Default 10.
   *
   * Not the same number as `axisThreshold`, and deliberately larger. Committing to an
   * axis at 4px is right for *starting* to track a drag — it has to beat a real swipe to
   * the punch. Treating that same 4px as "this was a drag, so eat the click" is not: a
   * plain mouse click drifts a few pixels between press and release all the time, and
   * every one of those was landing as a committed gesture that travelled nowhere, failed
   * to commit on release, and then ate its own click. The button simply went dead — which
   * is what happened to the drawer's search pill and the home bar, both of which do their
   * real work in `onclick`.
   */
  clickSuppressSlop?: number;
  /** Ratio-corrected, signed delta along the committed axis, called on every move once committed. */
  onMove: (delta: number, e: PointerEvent) => void;
  /** Called once on release, with the final delta and a rolling velocity estimate (units/ms). Only fires if the gesture committed to an axis. */
  onEnd: (delta: number, velocityPerMs: number) => void;
  /**
   * Fired once when a gesture ends without ever reaching `onEnd`. Two ways that happens:
   *
   * - movement locks to the *other* axis (a fixed `'x'`/`'y'` config with
   *   `crossAxisCancel`), before the pointer is captured or `onMove` has run; and
   * - **the gesture is detached while a committed drag is still in flight** — the effect
   *   that attached it re-ran, or the element was unmounted, and the cleanup tore the
   *   `window` listeners down. That drag will never see its own `pointerup`, so `onEnd`
   *   is never coming.
   *
   * The second case is why this is not merely informational. A consumer that writes
   * half-applied state on `onMove` and only resolves it in `onEnd` — every sheet here
   * sets a `'dragging'` phase that way — is otherwise left holding that state for the
   * life of the page, with no event that can ever clear it (MICA-106).
   */
  onCancel?: () => void;
  /**
   * Whether movement that locks to the other axis kills the gesture. Default true.
   *
   * Yielding is right wherever a cross-axis gesture is genuinely competing for the same
   * pixels — the shade's list has `SwipeableRow`, the drawer's grid has icons that pick up
   * in any direction — and those keep it.
   *
   * On a dedicated grab handle there is nothing to yield *to*, and the cancel is pure
   * cost. `lockAxis` decides on whichever pointermove first clears `axisThreshold`, and a
   * mouse clears 4px in one jump: a flick that starts even slightly more sideways than
   * vertical locked to `'x'`, and since a lost axis lock tears the listeners down, the
   * gesture was dead until the player released and pressed again. A perfectly diagonal
   * start died every time — `lockAxis` resolves ties to `'x'`. That is the "I have to try
   * way too hard to swipe it" the sheets had in both directions.
   *
   * With this off, movement is simply read along the configured axis and a sideways start
   * is a no-op rather than a rejection.
   */
  crossAxisCancel?: boolean;
  /** `axis: 'xy'` only — fired once, the moment movement commits to x or y. */
  onAxisLocked?: (axis: 'x' | 'y') => void;
  /**
   * Checked on every `pointerdown`, before any tracking starts. Returning `false` lets the
   * event fall through untouched — e.g. a container-wide close-swipe that must not steal a
   * scroll gesture already in progress inside a nested scrollable list.
   */
  shouldStart?: (e: PointerEvent) => boolean;
}

/**
 * Wires a scale-corrected, axis-disambiguated pointer drag to `element`.
 *
 * Deliberately does not capture the pointer or call `preventDefault` until an axis has
 * committed — capturing eagerly on `pointerdown` is exactly what broke the shade's
 * scrollable list in the removed "gestural pull drawer" attempt (see the comment
 * previously in `NotificationShade.svelte`). Until the axis locks, a move is free to be
 * claimed by native scrolling or another handler instead.
 *
 * Mirrors `dragScroll.ts`'s shape (an attach/cleanup closure, `window`-level move/up
 * listeners) and its click-swallow-on-release idiom, generalized so gesture call sites
 * don't each reimplement it.
 */
/**
 * The click-swallower armed by the most recent committed drag, if it has not fired yet.
 *
 * Module-level rather than per-gesture on purpose: the listener it tracks is on `window`,
 * so a stale one armed by *any* gesture disarms the next click anywhere in the phone. The
 * drawer had exactly that — a failed swipe up on the home bar left one behind, and the
 * search pill the player pressed next did nothing.
 */
let pendingClickSwallow: ((event: MouseEvent) => void) | null = null;

/**
 * Drop a swallower that never got its click.
 *
 * Called from every `pointerdown` as well as on a timer. The timer alone is not enough to
 * rely on — it is the prompt cleanup, not the guarantee — whereas a click is always
 * preceded by a pointerdown, so clearing there is what actually bounds how long a stale
 * swallower can survive.
 */
function clearPendingClickSwallow(): void {
  if (!pendingClickSwallow) return;
  window.removeEventListener('click', pendingClickSwallow, { capture: true });
  pendingClickSwallow = null;
}

export function attachDragGesture(element: HTMLElement, config: DragGestureConfig): () => void {
  const {
    axis,
    axisThreshold = 4,
    suppressClickAfterDrag = true,
    clickSuppressSlop = 10,
    onMove,
    onEnd,
    onCancel,
    crossAxisCancel = true,
    onAxisLocked,
    shouldStart
  } = config;

  let activePointerId: number | null = null;
  let committed = false;
  let startX = 0;
  let startY = 0;
  let dragRatio = 1;
  /** Furthest the gesture got from its origin, in raw px. Gates the click swallow below. */
  let peakTravel = 0;
  let velocityTracker = createVelocityTracker();
  // For a fixed 'x'/'y' config this is pinned up front. For 'xy' it stays null until the
  // first move locks it, and then never changes for the rest of the gesture.
  let lockedAxis: 'x' | 'y' | null = axis === 'xy' ? null : axis;

  function rawDeltaFor(e: PointerEvent): number {
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    return lockedAxis === 'x' ? deltaX : deltaY;
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activePointerId !== null) return;
    if (shouldStart && !shouldStart(e)) return;

    clearPendingClickSwallow();

    activePointerId = e.pointerId;
    committed = false;
    lockedAxis = axis === 'xy' ? null : axis;
    startX = e.clientX;
    startY = e.clientY;
    peakTravel = 0;
    dragRatio = measureDragRatio(element);
    velocityTracker = createVelocityTracker();

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  }

  function handlePointerMove(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    if (!committed) {
      const locked = lockAxis(deltaX, deltaY, axisThreshold);
      if (locked === null) return;
      if (axis !== 'xy' && locked !== axis) {
        if (crossAxisCancel) {
          stopTracking();
          onCancel?.();
          return;
        }
        // Falls through: the gesture commits to its configured axis regardless, and the
        // sideways component is just ignored from here on.
      }
      committed = true;
      lockedAxis = axis === 'xy' ? locked : axis;
      if (axis === 'xy') onAxisLocked?.(locked);
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        // jsdom has no PointerEvent capture support; a real browser may also throw if
        // the pointer was already released. Either way, non-fatal.
      }
    }

    e.preventDefault();
    peakTravel = Math.max(peakTravel, Math.abs(rawDeltaFor(e)));
    const correctedDelta = rawDeltaFor(e) / dragRatio;
    velocityTracker.record(correctedDelta, e.timeStamp);
    onMove(correctedDelta, e);
  }

  function handlePointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    const wasCommitted = committed;

    if (wasCommitted) {
      try {
        element.releasePointerCapture(e.pointerId);
      } catch {
        // See handlePointerMove.
      }
    }
    stopTracking();

    if (wasCommitted) {
      const correctedDelta = rawDeltaFor(e) / dragRatio;
      const velocity = velocityTracker.velocityPerMs();

      if (suppressClickAfterDrag && peakTravel >= clickSuppressSlop) {
        // `once` only spends the listener if a click actually arrives, and after a drag
        // one often does not — release the pointer over a different element than it went
        // down on and the browser fires no click at all. Left to itself the listener sat
        // on window indefinitely and ate the next unrelated click. It is tracked so a
        // later gesture can drop it, and cleared here first so two drags never stack two.
        clearPendingClickSwallow();
        const swallowClick = (clickEvent: MouseEvent) => {
          pendingClickSwallow = null;
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        };
        pendingClickSwallow = swallowClick;
        window.addEventListener('click', swallowClick, { capture: true, once: true });
        // The click, when there is one, is dispatched right after `pointerup`, so one
        // still armed a task later has none coming.
        setTimeout(clearPendingClickSwallow, 0);
      }

      onEnd(correctedDelta, velocity);
    }
  }

  function stopTracking() {
    activePointerId = null;
    committed = false;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerUp);
  }

  element.addEventListener('pointerdown', handlePointerDown);

  return () => {
    element.removeEventListener('pointerdown', handlePointerDown);
    // A committed drag that is torn down here has already had `onMove` applied and will
    // never reach `onEnd`: `stopTracking` drops the `window` listeners, so the eventual
    // `pointerup` lands on nothing. Read the flag before that, and tell the consumer to
    // abandon the gesture rather than leaving it half-applied forever.
    const wasCommitted = committed;
    stopTracking();
    if (wasCommitted) onCancel?.();
  };
}
