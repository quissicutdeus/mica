import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/reports').reports>;

export const pendingReportCount = store('reports', [], 'pendingReportCount', 0);

export function reports(): Twin {
  return {
    pendingReports: store('reports', [], 'pendingReports', []),
    resolvedReports: store('reports', [], 'resolvedReports', []),
    pendingReportCount,
    loadPendingReports: fn('reports', [], 'loadPendingReports'),
    loadReportHistory: fn('reports', [], 'loadReportHistory'),
    resolveReport: fn('reports', [], 'resolveReport'),
    reopenReport: fn('reports', [], 'reopenReport')
  } as unknown as Twin;
}
registerFacet('reports', reports);
