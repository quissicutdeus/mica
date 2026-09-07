// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { JobActionOutcome, JobView } from '../types';

/**
 * Jobs has no micaOS table — the framework is the only authority on what a player does for a
 * living — so every action here is custom, and every one of them answers with what the
 * framework says *afterwards* rather than with what the client asked for.
 *
 * `name` is bounded, not patterned: frameworks key jobs as lower_snake_case, but the server
 * never trusts the string on its own terms anyway. The handler compares it against the list
 * the framework already holds for this player and refuses anything outside it before the
 * name reaches a setter or a banking export (§2.9).
 */
export const jobsContract = defineContract({
  id: 'jobs',
  actions: {
    /** Every job the caller holds, active first, as the framework reads it right now. */
    getJobs: { input: s.none(), output: responseType<JobView[]>() },

    /** Make one of the held jobs the active one. */
    setActiveJob: {
      input: s.object({ name: s.string({ min: 1, max: 64 }) }),
      output: responseType<JobActionOutcome>()
    },

    /** Clock the active job on or off duty. */
    setDuty: {
      input: s.object({ name: s.string({ min: 1, max: 64 }), onDuty: s.boolean() }),
      output: responseType<JobActionOutcome>()
    }
  }
});
