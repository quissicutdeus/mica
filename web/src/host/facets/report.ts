// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { submitReport } from '../../services/reports';
import type { SubmitReportInput } from '@mica/sdk';

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
