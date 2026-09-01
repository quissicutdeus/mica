// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import {
  pendingReportCount,
  pendingReports,
  resolvedReports,
  loadPendingReports,
  loadReportHistory,
  reopenReport,
  resolveReport
} from '../../services/reports';
export { pendingReportCount };

export function reports() {
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

registerFacet('reports', reports);
