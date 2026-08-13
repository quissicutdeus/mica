import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import SwipeableRow from './SwipeableRow.svelte';

const noopSnippet = (() => {}) as never;

function firePointerEvent(
  target: EventTarget,
  type: string,
  opts: { clientX: number; clientY: number; timeMs: number }
) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX,
    clientY: opts.clientY,
    pointerId: 1,
    button: 0
  });
  Object.defineProperty(event, 'timeStamp', { value: opts.timeMs, configurable: true });
  target.dispatchEvent(event);
}

function fireTransformTransitionEnd(target: EventTarget) {
  const event = new Event('transitionend', { bubbles: false }) as TransitionEvent & {
    propertyName: string;
  };
  Object.defineProperty(event, 'propertyName', { value: 'transform' });
  target.dispatchEvent(event);
}

describe('SwipeableRow', () => {
  const renderRow = (onCommit = vi.fn()) => {
    const result = render(SwipeableRow, { props: { onCommit, children: noopSnippet } });
    const row = result.container.querySelector('[data-gesture-drag]');
    if (!row) throw new Error('SwipeableRow root not found');
    Object.defineProperty(row, 'offsetWidth', { value: 300, configurable: true });
    (row as HTMLElement).getBoundingClientRect = () => ({ width: 300 }) as DOMRect;
    return { ...result, row: row as HTMLElement, onCommit };
  };

  it('does not call onCommit synchronously when the swipe threshold is crossed', () => {
    const { row, onCommit } = renderRow();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 200, clientY: 0, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: 200, clientY: 0, timeMs: 10 });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('calls onCommit only after the exit transition finishes', () => {
    const { row, onCommit } = renderRow();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 200, clientY: 0, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: 200, clientY: 0, timeMs: 10 });

    expect(onCommit).not.toHaveBeenCalled();
    fireTransformTransitionEnd(row);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('never calls onCommit for a swipe that springs back under threshold', () => {
    const { row, onCommit } = renderRow();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 10, clientY: 0, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: 10, clientY: 0, timeMs: 10 });

    fireTransformTransitionEnd(row);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('never calls onCommit for a vertical drag (scrolling), which cancels the gesture', () => {
    const { row, onCommit } = renderRow();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 1, clientY: 200, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: 1, clientY: 200, timeMs: 10 });

    fireTransformTransitionEnd(row);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
