// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReportCategory } from '@gphone/shared/types';

/** What `Facets['report']` files. MICA-172 — see `./accounts.ts`. */
export interface SubmitReportInput {
  targetTable: string;
  targetId: number;
  category: ReportCategory;
  note?: string;
}
