import { registerFacet } from '../../current';
import { onAppUnmount } from './lifecycle';

/** Cancels the timer it came from. Safe to call more than once, and after it has fired. */
export type CancelTimer = () => void;

/** Implementation of the `useTimer` facet. See the `useTimer` hook doc for the usage contract. */
export function timer() {
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

registerFacet('timer', timer);
