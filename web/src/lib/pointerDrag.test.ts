import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  lockAxis,
  clampProgress,
  createVelocityTracker,
  shouldCommitDrag,
  shouldCommitSwipe,
  attachDragGesture
} from './pointerDrag';

describe('lockAxis', () => {
  it('returns null while both deltas are under threshold', () => {
    expect(lockAxis(1, 2, 4)).toBeNull();
    expect(lockAxis(-3, 3, 4)).toBeNull();
  });

  it('locks to x once the x delta crosses threshold and dominates', () => {
    expect(lockAxis(10, 2, 4)).toBe('x');
    expect(lockAxis(-10, 2, 4)).toBe('x');
  });

  it('locks to y once the y delta crosses threshold and dominates', () => {
    expect(lockAxis(2, 10, 4)).toBe('y');
    expect(lockAxis(2, -10, 4)).toBe('y');
  });

  it('resolves an exact tie to x', () => {
    expect(lockAxis(10, 10, 4)).toBe('x');
  });
});

describe('clampProgress', () => {
  it('clamps below 0 up to 0', () => {
    expect(clampProgress(-0.5)).toBe(0);
  });

  it('clamps above 1 down to 1', () => {
    expect(clampProgress(1.5)).toBe(1);
  });

  it('passes values already inside the range through unchanged', () => {
    expect(clampProgress(0.42)).toBe(0.42);
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(1)).toBe(1);
  });
});

describe('createVelocityTracker', () => {
  it('reports 0 with no samples', () => {
    expect(createVelocityTracker().velocityPerMs()).toBe(0);
  });

  it('reports 0 with a single sample', () => {
    const tracker = createVelocityTracker();
    tracker.record(10, 0);
    expect(tracker.velocityPerMs()).toBe(0);
  });

  it('computes signed px/ms from two samples', () => {
    const tracker = createVelocityTracker();
    tracker.record(0, 0);
    tracker.record(100, 50);
    expect(tracker.velocityPerMs()).toBeCloseTo(2);
  });

  it('reports negative velocity for a decreasing value', () => {
    const tracker = createVelocityTracker();
    tracker.record(100, 0);
    tracker.record(20, 40);
    expect(tracker.velocityPerMs()).toBeCloseTo(-2);
  });

  it('drops samples older than the window so a stale sample cannot skew a later read', () => {
    const tracker = createVelocityTracker(50);
    tracker.record(0, 0);
    tracker.record(1000, 10); // a huge, stale early jump (~100/ms)
    tracker.record(1010, 60); // then a slow, recent drift (1/ms)
    tracker.record(1020, 70);

    // By t=70 the 50ms window only reaches back to t=20, which prunes the {0,0} and
    // {1000,10} samples — the read reflects only the recent, slow drift.
    expect(tracker.velocityPerMs()).toBeCloseTo(1);
  });
});

describe('shouldCommitDrag', () => {
  it('commits once progress reaches the threshold, regardless of velocity', () => {
    expect(shouldCommitDrag(0.5, 0)).toBe(true);
    expect(shouldCommitDrag(0.9, -5)).toBe(true);
  });

  it('commits below the progress threshold on a fast enough flick', () => {
    expect(shouldCommitDrag(0.1, 2)).toBe(true);
  });

  it('springs back when neither the progress nor the velocity threshold is met', () => {
    expect(shouldCommitDrag(0.2, 0.1)).toBe(false);
  });

  it('honors custom thresholds', () => {
    expect(shouldCommitDrag(0.3, 0, { progressThreshold: 0.25 })).toBe(true);
    expect(shouldCommitDrag(0.1, 5, { velocityThreshold: 10 })).toBe(false);
  });
});

describe('shouldCommitSwipe', () => {
  it('commits once distance crosses the distance fraction of the container width', () => {
    expect(shouldCommitSwipe(200, 400, 0)).toBe(true);
    expect(shouldCommitSwipe(-200, 400, 0)).toBe(true);
  });

  it('does not commit below the distance fraction with no meaningful velocity', () => {
    expect(shouldCommitSwipe(50, 400, 0)).toBe(false);
  });

  it('commits on a fast flick past the minimum flick distance, even under the distance fraction', () => {
    expect(shouldCommitSwipe(30, 400, 1)).toBe(true);
  });

  it('does not commit a fast but tiny jerk under the minimum flick distance', () => {
    expect(shouldCommitSwipe(5, 400, 5)).toBe(false);
  });

  it('treats a zero container width as never satisfying the distance-fraction branch', () => {
    expect(shouldCommitSwipe(1000, 0, 0)).toBe(false);
  });
});

function firePointerEvent(
  target: EventTarget,
  type: string,
  opts: { clientX: number; clientY: number; pointerId?: number; timeMs: number; button?: number }
) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX,
    clientY: opts.clientY,
    pointerId: opts.pointerId ?? 1,
    button: opts.button ?? 0
  });
  Object.defineProperty(event, 'timeStamp', { value: opts.timeMs, configurable: true });
  target.dispatchEvent(event);
}

describe('attachDragGesture', () => {
  let element: HTMLElement;
  let cleanup: () => void;

  beforeEach(() => {
    element = document.createElement('div');
    document.body.appendChild(element);
  });

  afterEach(() => {
    cleanup?.();
    document.body.removeChild(element);
  });

  it('does not call onMove until the axis threshold is crossed', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    cleanup = attachDragGesture(element, { axis: 'y', onMove, onEnd });

    firePointerEvent(element, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 0, clientY: 2, timeMs: 5 });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('calls onMove with the ratio-corrected delta once the configured axis commits', () => {
    Object.defineProperty(element, 'offsetWidth', { value: 400, configurable: true });
    element.getBoundingClientRect = () => ({ width: 200 }) as DOMRect; // dragRatio 0.5

    const onMove = vi.fn();
    const onEnd = vi.fn();
    cleanup = attachDragGesture(element, { axis: 'y', onMove, onEnd });

    firePointerEvent(element, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 0, clientY: 20, timeMs: 10 });

    // Raw delta 20, ratio 0.5 → corrected delta 40.
    expect(onMove).toHaveBeenCalledWith(40, expect.anything());
  });

  it('cancels without ever calling onMove when movement locks to the other axis', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    cleanup = attachDragGesture(element, { axis: 'y', onMove, onEnd, onCancel });

    firePointerEvent(element, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 20, clientY: 1, timeMs: 5 });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();

    // Further movement along the committed-away axis must not resurrect the gesture.
    firePointerEvent(window, 'pointermove', { clientX: 40, clientY: 1, timeMs: 10 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('calls onEnd with the final delta and a velocity estimate once a committed drag releases', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    cleanup = attachDragGesture(element, { axis: 'x', onMove, onEnd });

    firePointerEvent(element, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 10, clientY: 0, timeMs: 10 });
    firePointerEvent(window, 'pointermove', { clientX: 50, clientY: 0, timeMs: 30 });
    firePointerEvent(window, 'pointerup', { clientX: 50, clientY: 0, timeMs: 30 });

    expect(onEnd).toHaveBeenCalledTimes(1);
    const [finalDelta, velocity] = onEnd.mock.calls[0];
    expect(finalDelta).toBe(50);
    expect(velocity).toBeGreaterThan(0);
  });

  it('never calls onEnd if the gesture never committed to an axis (a plain tap)', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    cleanup = attachDragGesture(element, { axis: 'y', onMove, onEnd });

    firePointerEvent(element, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointerup', { clientX: 0, clientY: 1, timeMs: 5 });

    expect(onEnd).not.toHaveBeenCalled();
  });

  it('ignores a second concurrent pointer while one gesture is already tracking', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    cleanup = attachDragGesture(element, { axis: 'y', onMove, onEnd });

    firePointerEvent(element, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 1, timeMs: 0 });
    firePointerEvent(element, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 2, timeMs: 1 });
    firePointerEvent(window, 'pointermove', {
      clientX: 0,
      clientY: 20,
      pointerId: 2,
      timeMs: 5
    });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('stops responding to further events once the returned cleanup runs', () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const detach = attachDragGesture(element, { axis: 'y', onMove, onEnd });

    firePointerEvent(element, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 0, clientY: 20, timeMs: 5 });
    expect(onMove).toHaveBeenCalledTimes(1);

    detach();

    firePointerEvent(window, 'pointermove', { clientX: 0, clientY: 40, timeMs: 10 });
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});
