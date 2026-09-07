// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * OS Service Hook for the jobs a player holds (MICA-228): the list, the active one, and
 * duty. Behind its own `jobs` permission rather than `account`, because switching the
 * active job changes what every other resource on the server thinks the player is
 * doing — that is not a read, and `account` is declared by anything showing a balance.
 * Absent on a standalone server; an app that cannot work without it says
 * `requires: ['jobs']`.
 */
export function useJobs() {
  return guarded('useJobs').facets.jobs();
}
