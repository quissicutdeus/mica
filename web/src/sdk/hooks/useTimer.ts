import { onAppUnmount } from './lifecycle';

/** Cancels the timer it came from. Safe to call more than once, and after it has fired. */
export type CancelTimer = () => void;

/**
 * Timers that cannot outlive the app that started them.
 *
 * Residency is what makes this more than tidiness. An app stays mounted after you leave
 * it and is unmounted later, without warning, when it falls off the end of
 * `MAX_RESIDENT_APPS` — so a bare `setTimeout` can fire against a torn-down component
 * tree, and the callback writes to state nothing is rendering any more. Three sites had
 * no stored handle at all and could not have been cleaned up even deliberately.
 *
 * `onAppUnmount` clears whatever is still pending. Note the argument order is
 * duration-first — `after(600, fn)` reads as the sentence it is — which is the
 * opposite of `setTimeout`.
 *
 * ```ts
 * const { after } = useTimer();
 * const cancel = after(600, () => (bouncing = false));
 * ```
 */
export function useTimer() {
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();

  const after = (ms: number, handler: () => void): CancelTimer => {
    const id = setTimeout(() => {
      // Drop it before running: a one-shot that has fired is not pending, and holding
      // the id would leak one entry per timer for the life of the app.
      timeouts.delete(id);
      handler();
    }, ms);
    timeouts.add(id);

    return () => {
      clearTimeout(id);
      timeouts.delete(id);
    };
  };

  const every = (ms: number, handler: () => void): CancelTimer => {
    const id = setInterval(handler, ms);
    intervals.add(id);

    return () => {
      clearInterval(id);
      intervals.delete(id);
    };
  };

  const clearAll = () => {
    for (const id of timeouts) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
    timeouts.clear();
    intervals.clear();
  };

  onAppUnmount(clearAll);

  return { after, every, clearAll };
}
