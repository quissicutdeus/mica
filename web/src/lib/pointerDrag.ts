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
  axis: 'x' | 'y';
  /** Px of raw (uncorrected) movement before the gesture commits to `axis`. Default 4, matching dragScroll.ts. */
  axisThreshold?: number;
  /** Swallow the next `click` once a real drag has committed, so drag-release doesn't also fire a tap handler. Default true. */
  suppressClickAfterDrag?: boolean;
  /** Ratio-corrected, signed delta along `axis`, called on every move once committed. */
  onMove: (delta: number, e: PointerEvent) => void;
  /** Called once on release, with the final delta and a rolling velocity estimate (units/ms). Only fires if the gesture committed to `axis`. */
  onEnd: (delta: number, velocityPerMs: number) => void;
  /** Fired once if movement locks to the *other* axis — the gesture never captures the pointer or calls `onMove`/`onEnd`. */
  onCancel?: () => void;
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
export function attachDragGesture(element: HTMLElement, config: DragGestureConfig): () => void {
  const {
    axis,
    axisThreshold = 4,
    suppressClickAfterDrag = true,
    onMove,
    onEnd,
    onCancel
  } = config;

  let activePointerId: number | null = null;
  let committed = false;
  let startX = 0;
  let startY = 0;
  let dragRatio = 1;
  let velocityTracker = createVelocityTracker();

  function rawDeltaFor(e: PointerEvent): number {
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    return axis === 'x' ? deltaX : deltaY;
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activePointerId !== null) return;

    activePointerId = e.pointerId;
    committed = false;
    startX = e.clientX;
    startY = e.clientY;
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
      if (locked !== axis) {
        stopTracking();
        onCancel?.();
        return;
      }
      committed = true;
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        // jsdom has no PointerEvent capture support; a real browser may also throw if
        // the pointer was already released. Either way, non-fatal.
      }
    }

    e.preventDefault();
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

      if (suppressClickAfterDrag) {
        const swallowClick = (clickEvent: MouseEvent) => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        };
        window.addEventListener('click', swallowClick, { capture: true, once: true });
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
    stopTracking();
  };
}
