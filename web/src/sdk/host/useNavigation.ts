import './inProcess/facets/navigation';
import { guarded } from './guard';

/**
 * OS Service Hook for phone navigation (opening apps, returning home, closing phone shell).
 */
export function useNavigation() {
  return guarded('useNavigation').facets.navigation();
}
