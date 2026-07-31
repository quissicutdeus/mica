import { fetchNui } from '../../utils/fetchNui';
import { useNuiEvent } from '../../utils/useNuiEvent';

/**
 * OS Service Hook for FiveM NUI transport bridge events.
 */
export function useNuiBridge() {
  return {
    fetchNui,
    useNuiEvent
  };
}
