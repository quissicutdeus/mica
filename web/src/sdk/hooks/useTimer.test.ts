import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useTimer } from './useTimer';

describe('useTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a one-shot after the delay, and not before', () => {
    const { after } = useTimer();
    const fn = vi.fn();

    after(600, fn);
    vi.advanceTimersByTime(599);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('repeats an interval', () => {
    const { every } = useTimer();
    const fn = vi.fn();

    every(100, fn);
    vi.advanceTimersByTime(350);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('cancels a pending one-shot through the returned function', () => {
    const { after } = useTimer();
    const fn = vi.fn();

    const cancel = after(600, fn);
    cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });

  it('survives cancelling twice, and cancelling after it has fired', () => {
    // Both happen in real code: Settings cancels a pending tap-reset that may already
    // have run, and the unlock path cancels it a second time.
    const { after } = useTimer();
    const cancel = after(10, () => {});

    vi.advanceTimersByTime(50);

    expect(() => {
      cancel();
      cancel();
    }).not.toThrow();
  });

  it('clearAll stops everything still pending', () => {
    const { after, every, clearAll } = useTimer();
    const once = vi.fn();
    const repeatedly = vi.fn();

    after(100, once);
    every(100, repeatedly);
    clearAll();
    vi.advanceTimersByTime(1000);

    expect(once).not.toHaveBeenCalled();
    expect(repeatedly).not.toHaveBeenCalled();
  });

  it('clearAll is a no-op once everything has fired', () => {
    // Note this cannot observe the internal set being pruned as one-shots fire — that
    // is memory hygiene with no external signal. What it does pin down is that a spent
    // timer set is safe to clear, which is the path `onAppUnmount` takes for any app
    // that has been sitting idle.
    const { after, clearAll } = useTimer();

    for (let i = 0; i < 100; i++) after(10, () => {});
    vi.advanceTimersByTime(50);

    expect(() => clearAll()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs outside a component without throwing', () => {
    // `onAppUnmount` swallows the out-of-lifecycle error, which is what makes the hook
    // usable from a plain unit test at all.
    expect(() => useTimer()).not.toThrow();
  });
});
