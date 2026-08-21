import './inProcess/facets/appAction';
import { guarded } from './guard';
export type { AppActionOptions } from './inProcess/facets/appAction';

/**
 * OS Service Hook for running one user-initiated action.
 */
export function useAppAction(appId?: string) {
  return guarded('useAppAction', appId).facets.appAction(appId);
}
