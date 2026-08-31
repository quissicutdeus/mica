import { guarded } from './guard';

/**
 * OS Service Hook for changing how the phone's clock is displayed (MICA-127) — the
 * 12/24-hour preference. Separate from `useClock()`, which only reads it.
 */
export function useClockWrite() {
  return guarded('useClockWrite').facets.clockWrite();
}
