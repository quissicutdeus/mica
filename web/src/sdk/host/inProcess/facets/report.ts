import { registerFacet } from '../../current';
import { submitReport, type SubmitReportInput } from '../../../../services/reports';

export type { SubmitReportInput };

/**
 * Report a piece of content.
 *
 * Split from `useReports` — the moderation *queue* — because the two are different
 * capabilities: every social app lets a player file a report, and only Admin reads them.
 * `ReportDialog` is the usual caller; an app that files reports from its own UI uses this.
 */
export function report() {
  return {
    submit: (input: SubmitReportInput) => submitReport(input)
  };
}

registerFacet('report', report);
