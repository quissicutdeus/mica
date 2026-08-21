import './inProcess/facets/reports';
import { guarded } from './guard';
export { pendingReportCount } from './inProcess/facets/reports';

export function useReports() {
  return guarded('useReports').facets.reports();
}
