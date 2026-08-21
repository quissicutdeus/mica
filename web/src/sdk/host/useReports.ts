import {
  pendingReportCount,
  pendingReports,
  resolvedReports,
  loadPendingReports,
  loadReportHistory,
  reopenReport,
  resolveReport
} from '../../services/reports';

/**
 * OS Service Hook for the moderation queue.
 *
 * Every call behind this is refused server-side for a non-admin, so a non-admin app
 * using it sees empty lists rather than someone else's reports.
 */
/**
 * Re-exported for manifests, which need the store itself rather than a hook call —
 * matching `unreadMailCount`. Importing it from the store directly would reach across
 * the app boundary, which `sdk/boundary.test.ts` refuses.
 */
export { pendingReportCount };

export function useReports() {
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
