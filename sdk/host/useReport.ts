// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';
export type { SubmitReportInput } from '../vocabulary/reports';

/**
 * Report a piece of content.
 */
export function useReport() {
  return guarded('useReport').facets.report();
}
