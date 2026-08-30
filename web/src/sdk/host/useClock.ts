import './inProcess/facets/clock';
import { guarded } from './guard';

/**
 * The phone's clock, and how it is displayed — read-only. Changing the 12/24-hour
 * preference is `useClockWrite` (MICA-127).
 */
export function useClock() {
  return guarded('useClock').facets.clock();
}
