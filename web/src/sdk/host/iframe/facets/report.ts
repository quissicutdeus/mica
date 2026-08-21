import { registerFacet } from '../../current';
import { fn } from './_shared';

export type { SubmitReportInput } from '../../inProcess/facets/report';

type Twin = ReturnType<typeof import('../../inProcess/facets/report').report>;

export function report(): Twin {
  return {
    submit: fn('report', [], 'submit')
  } as unknown as Twin;
}
registerFacet('report', report);
