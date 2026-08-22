import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, type AsTwin } from './_shared';

export type { SubmitReportInput } from '../../inProcess/facets/report';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/report').report>>;

export function report(): Twin {
  return {
    submit: fn('report', [], 'submit')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('report', report as unknown as Facets['report']);
