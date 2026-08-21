import './inProcess/facets/report';
import { guarded } from './guard';
export type { SubmitReportInput } from './inProcess/facets/report';

/**
 * Report a piece of content.
 */
export function useReport() {
  return guarded('useReport').facets.report();
}
