import './inProcess/facets/appEvents';
import { guarded } from './guard';

/**
 * OS Service Hook for events the server pushes to this app.
 */
export function useAppEvents(appId: string) {
  return guarded('useAppEvents', appId).facets.appEvents(appId);
}
