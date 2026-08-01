import { fetchNui } from '../../nui/fetchNui';
import { useNuiEvent } from '../../nui/useNuiEvent';

/**
 * OS Service Hook for FiveM NUI transport bridge events.
 */
export function useNuiBridge() {
  return {
    fetchNui,
    useNuiEvent
  };
}
