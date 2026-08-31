import { guarded } from './guard';
export type { SubmitReportInput } from '../../host/facets/report';

/**
 * Report a piece of content.
 */
export function useReport() {
  return guarded('useReport').facets.report();
}
