import './inProcess/facets/reports';
import { guarded } from './guard';
export { pendingReportCount } from './inProcess/facets/reports';

/**
 * OS Service Hook for filing and viewing player reports.
 */
export function useReports() {
  return guarded('useReports').facets.reports();
}
