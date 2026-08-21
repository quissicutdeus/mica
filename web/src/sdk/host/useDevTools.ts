import './inProcess/facets/devTools';
import { guarded } from './guard';

/**
 * OS Service Hook for the Developer Tools reveal.
 */
export function useDevTools() {
  return guarded('useDevTools').facets.devTools();
}
