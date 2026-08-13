import { describe, it, expect } from 'vitest';
import { measureDragRatio } from './dragRatio';

describe('measureDragRatio', () => {
  it('returns 1 when the element has not been laid out (jsdom, zero dimensions)', () => {
    const el = document.createElement('div');
    expect(measureDragRatio(el)).toBe(1);
  });

  it('returns the rendered-to-layout ratio when both are non-zero', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true });
    el.getBoundingClientRect = () => ({ width: 300 }) as DOMRect;

    expect(measureDragRatio(el)).toBeCloseTo(0.75);
  });

  it('falls back to 1 when only one side is zero', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetWidth', { value: 0, configurable: true });
    el.getBoundingClientRect = () => ({ width: 300 }) as DOMRect;

    expect(measureDragRatio(el)).toBe(1);
  });
});
