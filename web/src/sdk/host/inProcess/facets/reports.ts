import { registerFacet } from '../../current';
import {
  pendingReportCount,
  pendingReports,
  resolvedReports,
  loadPendingReports,
  loadReportHistory,
  reopenReport,
  resolveReport
} from '../../../../services/reports';
export { pendingReportCount };

export function reports() {
  return {
    pendingReports,
    resolvedReports,
    pendingReportCount,
    loadPendingReports,
    loadReportHistory,
    resolveReport,
    reopenReport
  };
}

registerFacet('reports', reports);
