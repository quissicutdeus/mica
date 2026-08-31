import { guarded } from './guard';
export type { SubmitReportInput } from '../vocabulary/reports';

/**
 * Report a piece of content.
 */
export function useReport() {
  return guarded('useReport').facets.report();
}
