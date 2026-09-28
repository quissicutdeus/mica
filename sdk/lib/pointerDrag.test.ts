// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureDragRatio, pointerDrag } from './pointerDrag';

/** An element drawn at `rendered` px wide whose own layout width is `layout`. */
const scaled = (el: HTMLElement, layout: number, rendered: number) => {
  Object.defineProperty(el, 'offsetWidth', { value: layout, configurable: true });
  el.getBoundingClientRect = () => ({ width: rendered }) as DOMRect;
};

const fire = (
  target: EventTarget,
  type: string,
  opts: { x: number; y: number; id?: number; button?: number }
) =>
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: opts.x,
      clientY: opts.y,
      pointerId: opts.id ?? 1,
      button: opts.button ?? 0
    })
  );

describe('measureDragRatio (MICA-294)', () => {
  it('answers 1 when nothing is laid out, so jsdom applies no correction', () => {
    expect(measureDragRatio(document.createElement('div'))).toBe(1);
  });

  it('answers rendered over layout width', () => {
    const el = document.createElement('div');
    scaled(el, 400, 300);
    expect(measureDragRatio(el)).toBeCloseTo(0.75);
  });

  it('answers 1 when only one side is zero', () => {
    const el = document.createElement('div');
    scaled(el, 0, 300);
    expect(measureDragRatio(el)).toBe(1);
  });
});

describe('pointerDrag (MICA-294)', () => {
  let el: HTMLElement;
  let action: ReturnType<typeof pointerDrag> | undefined;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
  });

  afterEach(() => {
    action?.destroy();
    action = undefined;
    el.remove();
  });

  it('reports travel since the press, corrected for the element being drawn at half size', () => {
    scaled(el, 400, 200);
    const onmove = vi.fn();
    const onend = vi.fn();
    action = pointerDrag(el, { onmove, onend });

    fire(el, 'pointerdown', { x: 100, y: 100 });
    fire(el, 'pointermove', { x: 110, y: 95 });
    fire(el, 'pointermove', { x: 130, y: 90 });
    fire(el, 'pointerup', { x: 130, y: 90 });

    // Cumulative, not per-event: 30px and -10px of cursor are 60 and -20 layout pixels.
    expect(onmove.mock.calls.map(([dx, dy]) => [dx, dy])).toEqual([
      [20, -10],
      [60, -20]
    ]);
    expect(onend).toHaveBeenCalledTimes(1);
    expect(onend.mock.calls[0].slice(0, 2)).toEqual([60, -20]);
  });

  it('ignores a secondary mouse button', () => {
    const onstart = vi.fn();
    const onmove = vi.fn();
    action = pointerDrag(el, { onstart, onmove });

    fire(el, 'pointerdown', { x: 0, y: 0, button: 2 });
    fire(el, 'pointermove', { x: 10, y: 10 });

    expect(onstart).not.toHaveBeenCalled();
    expect(onmove).not.toHaveBeenCalled();
  });

  it('leaves a press alone when onstart returns false', () => {
    const onmove = vi.fn();
    action = pointerDrag(el, { onstart: () => false, onmove });

    fire(el, 'pointerdown', { x: 0, y: 0 });
    fire(el, 'pointermove', { x: 10, y: 10 });

    expect(onmove).not.toHaveBeenCalled();
  });

  it('follows one pointer, and ignores a second until the first lifts', () => {
    const onmove = vi.fn();
    const onend = vi.fn();
    action = pointerDrag(el, { onmove, onend });

    fire(el, 'pointerdown', { x: 0, y: 0, id: 1 });
    fire(el, 'pointerdown', { x: 50, y: 50, id: 2 });
    fire(el, 'pointermove', { x: 70, y: 70, id: 2 });
    fire(el, 'pointerup', { x: 70, y: 70, id: 2 });
    expect(onmove).not.toHaveBeenCalled();
    expect(onend).not.toHaveBeenCalled();

    fire(el, 'pointermove', { x: 5, y: 0, id: 1 });
    expect(onmove).toHaveBeenLastCalledWith(5, 0, expect.anything());
  });

  it('ends on pointercancel, and says so through the event', () => {
    const onend = vi.fn();
    action = pointerDrag(el, { onmove: () => {}, onend });

    fire(el, 'pointerdown', { x: 0, y: 0 });
    fire(el, 'pointercancel', { x: 3, y: 4 });

    expect(onend).toHaveBeenCalledTimes(1);
    expect((onend.mock.calls[0][2] as PointerEvent).type).toBe('pointercancel');
  });

  it('ends a drag once, even when the capture is reported lost afterwards', () => {
    const onend = vi.fn();
    action = pointerDrag(el, { onmove: () => {}, onend });

    fire(el, 'pointerdown', { x: 0, y: 0 });
    fire(el, 'pointerup', { x: 1, y: 1 });
    fire(el, 'lostpointercapture', { x: 1, y: 1 });

    expect(onend).toHaveBeenCalledTimes(1);
  });

  it('uses the handlers from the latest update', () => {
    const first = vi.fn();
    const second = vi.fn();
    action = pointerDrag(el, { onmove: first });
    action.update({ onmove: second });

    fire(el, 'pointerdown', { x: 0, y: 0 });
    fire(el, 'pointermove', { x: 1, y: 0 });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops listening once destroyed', () => {
    const onmove = vi.fn();
    const onend = vi.fn();
    action = pointerDrag(el, { onmove, onend });

    fire(el, 'pointerdown', { x: 0, y: 0 });
    action.destroy();
    action = undefined;
    fire(el, 'pointermove', { x: 10, y: 10 });
    fire(el, 'pointerup', { x: 10, y: 10 });

    expect(onmove).not.toHaveBeenCalled();
    expect(onend).not.toHaveBeenCalled();
  });
});
