import './inProcess/facets/timer';
import { guarded } from './guard';
export type { CancelTimer } from './inProcess/facets/timer';

/**
 * Timers that cannot outlive the app that started them.
 */
export function useTimer() {
  return guarded('useTimer').facets.timer();
}
