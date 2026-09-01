// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import SwipeableToast from './SwipeableToast.svelte';

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

describe('SwipeableToast', () => {
  const renderToast = (onArchive = vi.fn(), onHide = vi.fn()) => {
    const result = render(SwipeableToast, {
      props: { onArchive, onHide, children: noopSnippet }
    });
    const row = result.container.querySelector('[data-gesture-drag]');
    if (!row) throw new Error('SwipeableToast root not found');
    Object.defineProperty(row, 'offsetWidth', { value: 300, configurable: true });
    Object.defineProperty(row, 'offsetHeight', { value: 80, configurable: true });
    (row as HTMLElement).getBoundingClientRect = () => ({ width: 300 }) as DOMRect;
    return { ...result, row: row as HTMLElement, onArchive, onHide };
  };

  it('calls onArchive after a rightward swipe past threshold commits', () => {
    const { row, onArchive, onHide } = renderToast();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 200, clientY: 0, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: 200, clientY: 0, timeMs: 10 });
    fireTransformTransitionEnd(row);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onHide).not.toHaveBeenCalled();
  });

  it('calls onArchive after a leftward swipe past threshold commits', () => {
    const { row, onArchive } = renderToast();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: -200, clientY: 0, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: -200, clientY: 0, timeMs: 10 });
    fireTransformTransitionEnd(row);

    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('calls onHide, not onArchive, after an upward swipe past threshold commits', () => {
    const { row, onArchive, onHide } = renderToast();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 0, clientY: -60, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: 0, clientY: -60, timeMs: 10 });
    fireTransformTransitionEnd(row);

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('never commits a downward swipe — no action is defined for it', () => {
    const { row, onArchive, onHide } = renderToast();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 0, clientY: 60, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: 0, clientY: 60, timeMs: 10 });
    fireTransformTransitionEnd(row);

    expect(onArchive).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
  });

  it('never commits a swipe that springs back under threshold', () => {
    const { row, onArchive, onHide } = renderToast();

    firePointerEvent(row, 'pointerdown', { clientX: 0, clientY: 0, timeMs: 0 });
    firePointerEvent(window, 'pointermove', { clientX: 10, clientY: 0, timeMs: 10 });
    firePointerEvent(window, 'pointerup', { clientX: 10, clientY: 0, timeMs: 10 });
    fireTransformTransitionEnd(row);

    expect(onArchive).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
  });
});
