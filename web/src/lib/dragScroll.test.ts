import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { enableDragScroll } from './dragScroll';

describe('Drag Scroll Utility', () => {
  let container: HTMLDivElement;
  let scrollable: HTMLDivElement;
  let cleanup: () => void;

  beforeEach(() => {
    container = document.createElement('div');
    scrollable = document.createElement('div');
    scrollable.style.overflowY = 'auto';
    scrollable.style.height = '200px';

    // Mock scrollHeight and clientHeight for Vitest jsdom environment
    Object.defineProperty(scrollable, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });

    container.appendChild(scrollable);
    document.body.appendChild(container);

    cleanup = enableDragScroll(container);
  });

  afterEach(() => {
    if (cleanup) cleanup();
    document.body.removeChild(container);
  });

  it('attaches event listeners and handles drag scrolling', () => {
    scrollable.scrollTop = 50;

    const mouseDownEvent = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
      button: 0
    });
    scrollable.dispatchEvent(mouseDownEvent);

    const mouseMoveEvent = new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 50 // Dragged up 50px
    });
    window.dispatchEvent(mouseMoveEvent);

    expect(scrollable.scrollTop).toBe(100);

    const mouseUpEvent = new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true
    });
    window.dispatchEvent(mouseUpEvent);
  });
});
