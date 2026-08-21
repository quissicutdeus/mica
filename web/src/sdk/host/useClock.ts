import './inProcess/facets/clock';
import { guarded } from './guard';

/**
 * The phone's clock, and how it is displayed.
 */
export function useClock() {
  return guarded('useClock').facets.clock();
}
