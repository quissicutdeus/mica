import { describe, it, expect, vi } from 'vitest';
import { useScrollDetect } from './useScrollDetect';

// Mock svelte onMount to execute callback synchronously for unit testing
vi.mock('svelte', () => ({
  onMount: (fn: () => void | (() => void)) => {
    const cleanup = fn();
    return cleanup;
  }
}));

describe('useScrollDetect', () => {
  it('detects scroll threshold on overflow-y-auto containers', () => {
    let scrolled = false;
    const setter = (val: boolean) => { scrolled = val; };

    let scrollListener: ((e: Event) => void) | null = null;
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener').mockImplementation((event, listener) => {
      if (event === 'scroll') {
        scrollListener = listener as (e: Event) => void;
      }
    });

    useScrollDetect(setter, 20);

    expect(addEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(scrollListener).not.toBeNull();

    // Trigger scroll event below threshold
    scrollListener!({
      target: {
        scrollTop: 10,
        classList: { contains: (cls: string) => cls === 'overflow-y-auto' }
      }
    } as unknown as Event);
    expect(scrolled).toBe(false);

    // Trigger scroll event above threshold
    scrollListener!({
      target: {
        scrollTop: 25,
        classList: { contains: (cls: string) => cls === 'overflow-y-auto' }
      }
    } as unknown as Event);
    expect(scrolled).toBe(true);

    addEventListenerSpy.mockRestore();
  });
});
