import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['reports']>>;

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
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('reports', reports as unknown as Facets['reports']);
