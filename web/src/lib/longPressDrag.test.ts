import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachLongPressDrag } from './longPressDrag';

function pointerEvent(type: string, x: number, y: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId,
    bubbles: true,
    cancelable: true
  });
}

describe('attachLongPressDrag', () => {
  let element: HTMLElement;
  let onLongPress: ReturnType<typeof vi.fn>;
  let onDragMove: ReturnType<typeof vi.fn>;
  let onDragEnd: ReturnType<typeof vi.fn>;
  let onDragCancel: ReturnType<typeof vi.fn>;
  let detach: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    element = document.createElement('div');
    document.body.appendChild(element);
    onLongPress = vi.fn();
    onDragMove = vi.fn();
    onDragEnd = vi.fn();
    onDragCancel = vi.fn();
    detach = attachLongPressDrag(element, {
      onLongPress: onLongPress as (e: PointerEvent) => void,
      onDragMove: onDragMove as (x: number, y: number, e: PointerEvent) => void,
      onDragEnd: onDragEnd as (x: number, y: number, e: PointerEvent) => void,
      onDragCancel: onDragCancel as () => void
    });
  });

  afterEach(() => {
    detach();
    element.remove();
    vi.useRealTimers();
  });

  it('fires onLongPress after holdMs with no movement', () => {
    element.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    expect(onLongPress).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('fires onDragCancel, not onLongPress, when released before holdMs', () => {
    element.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    vi.advanceTimersByTime(300);
    window.dispatchEvent(pointerEvent('pointerup', 10, 10));

    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onDragCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the timer when the pointer moves past moveTolerance before holdMs', () => {
    element.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    vi.advanceTimersByTime(100);
    window.dispatchEvent(pointerEvent('pointermove', 40, 10));

    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onDragCancel).toHaveBeenCalledTimes(1);
  });

  it('tolerates small movement before holdMs without cancelling', () => {
    element.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    vi.advanceTimersByTime(100);
    window.dispatchEvent(pointerEvent('pointermove', 13, 10));

    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onDragCancel).not.toHaveBeenCalled();
  });

  it('calls onDragMove and onDragEnd only after the long-press has armed', () => {
    element.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    window.dispatchEvent(pointerEvent('pointermove', 20, 30));
    expect(onDragMove).toHaveBeenCalledWith(20, 30, expect.anything());

    window.dispatchEvent(pointerEvent('pointerup', 25, 35));
    expect(onDragEnd).toHaveBeenCalledWith(25, 35, expect.anything());
    expect(onDragCancel).not.toHaveBeenCalled();
  });

  it('ignores a second pointer while one is already tracked', () => {
    element.dispatchEvent(pointerEvent('pointerdown', 10, 10, 1));
    element.dispatchEvent(pointerEvent('pointerdown', 50, 50, 2));

    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
