// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import {
  fetchJobs,
  jobs as jobsStore,
  jobsLoaded,
  setActiveJob,
  setDuty
} from '../../services/jobs';

/**
 * OS Service Hook for the jobs a player holds (MICA-228). The in-process half of
 * `useJobs()`; `sdk/host/iframe/facets/jobs.ts` is the add-on twin.
 */
export function jobs() {
  return {
    jobs: jobsStore,
    jobsLoaded,
    fetchJobs: () => fetchJobs(),
    setActiveJob: (name: string) => setActiveJob(name),
    setDuty: (name: string, onDuty: boolean) => setDuty(name, onDuty)
  };
}

registerFacet('jobs', jobs);
