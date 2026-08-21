import './inProcess/facets/sound';
import { guarded } from './guard';

/**
 * The phone's sound effects.
 */
export function useSound() {
  return guarded('useSound').facets.sound();
}
