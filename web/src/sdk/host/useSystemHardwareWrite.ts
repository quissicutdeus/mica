import './inProcess/facets/systemHardwareWrite';
import { guarded } from './guard';

/**
 * OS Service Hook for changing the phone's hardware (MICA-127) — signal, cell service,
 * bluetooth, volume, the ringer, and (Developer Tools only) faking a battery level.
 * Separate from `useSystemHardware()`, which only reads it.
 */
export function useSystemHardwareWrite() {
  return guarded('useSystemHardwareWrite').facets.systemHardwareWrite();
}
