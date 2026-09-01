// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for the address this server says its source lives at (AGPL §13).
 *
 * The default is upstream and true for an unmodified server; an operator running a fork
 * sets `gphone_source_url`, because §13's obligation is theirs and their players are
 * entitled to *their* source. Settings > About > License is what shows it.
 */
export function useSourceUrl() {
  return guarded('useSourceUrl').facets.sourceUrl();
}
