import './inProcess/facets/systemHardware';
import { guarded } from './guard';

/**
 * The phone's hardware: battery, cellular signal, cell service, bluetooth, and volume controls.
 */
export function useSystemHardware() {
  return guarded('useSystemHardware').facets.systemHardware();
}
