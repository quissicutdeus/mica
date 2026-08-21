import './inProcess/facets/timer';
import { guarded } from './guard';
export type { CancelTimer } from './inProcess/facets/timer';

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
  return guarded('useTimer').facets.timer();
}
