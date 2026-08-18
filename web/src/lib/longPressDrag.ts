/**
 * Long-press-then-drag, for picking an icon up off the App Drawer/home grid.
 *
 * Distinct from `attachDragGesture` (pointerDrag.ts): that gesture commits to an axis
 * within a few pixels of movement, which is right for a swipe (the shade, the drawer's own
 * swipe-up) but wrong here — a tap that opens an app and a press-and-hold that picks it up
 * both start with the pointer sitting still, and the two are told apart by *time*, not by
 * axis. `attachDragGesture`'s pointerdown/move/up plumbing (raw client coordinates, no
 * scale correction — a drag ghost tracks the *viewport*, not phone-design pixels the way a
 * swipe's progress does) is close enough in shape that this mirrors it rather than
 * reaching for something unrelated, but the state machine itself — "arm after `holdMs`
 * unless the pointer moved too far first" — has no existing counterpart in this codebase.
 */
export interface LongPressDragConfig {
  /** Milliseconds of stillness before a long-press is recognized. Default 500 (the AC's own number). */
  holdMs?: number;
  /** Px of pointer movement before `holdMs` elapses that cancels the long-press outright — lets an ordinary tap or an unrelated swipe starting on the same element (e.g. the drawer's swipe-down-to-close, if it touches an icon) fall through instead of arming a drag. Default 8. */
  moveTolerance?: number;
  /** Fires once, exactly at `holdMs`, if the pointer stayed within `moveTolerance`. */
  onLongPress: (e: PointerEvent) => void;
  /** Fires on every pointer move *after* `onLongPress`, in viewport coordinates. */
  onDragMove: (x: number, y: number, e: PointerEvent) => void;
  /** Fires on release *after* `onLongPress` fired. */
  onDragEnd: (x: number, y: number, e: PointerEvent) => void;
  /** Fires when the pointer is released or moves past tolerance before `onLongPress` fires — i.e. this was a tap or an unrelated gesture, not a long-press. */
  onDragCancel: () => void;
}

export function attachLongPressDrag(element: HTMLElement, config: LongPressDragConfig): () => void {
  const {
    holdMs = 500,
    moveTolerance = 8,
    onLongPress,
    onDragMove,
    onDragEnd,
    onDragCancel
  } = config;

  let activePointerId: number | null = null;
  let armed = false;
  let startX = 0;
  let startY = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activePointerId !== null) return;

    activePointerId = e.pointerId;
    armed = false;
    startX = e.clientX;
    startY = e.clientY;

    timer = setTimeout(() => {
      timer = null;
      armed = true;
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        // jsdom / already-released pointer — non-fatal, mirrors pointerDrag.ts.
      }
      onLongPress(e);
    }, holdMs);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  }

  function handlePointerMove(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;

    if (!armed) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > moveTolerance) {
        clearTimer();
        stopTracking();
        onDragCancel();
      }
      return;
    }

    onDragMove(e.clientX, e.clientY, e);
  }

  function handlePointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    const wasArmed = armed;

    if (wasArmed) {
      try {
        element.releasePointerCapture(e.pointerId);
      } catch {
        // See handlePointerDown.
      }
    }
    clearTimer();
    stopTracking();

    if (wasArmed) {
      onDragEnd(e.clientX, e.clientY, e);
    } else {
      onDragCancel();
    }
  }

  function handlePointerCancel(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    clearTimer();
    stopTracking();
    onDragCancel();
  }

  function stopTracking() {
    activePointerId = null;
    armed = false;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerCancel);
  }

  element.addEventListener('pointerdown', handlePointerDown);

  return () => {
    clearTimer();
    element.removeEventListener('pointerdown', handlePointerDown);
    stopTracking();
  };
}
