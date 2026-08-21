import './inProcess/facets/appRegistry';
import { guarded } from './guard';

/**
 * OS Service Hook for dynamic app registry & remote app installation.
 */
export function useAppRegistry() {
  return guarded('useAppRegistry').facets.appRegistry();
}
