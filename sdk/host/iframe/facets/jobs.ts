// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['jobs']>>;

/** The iframe twin of `web/src/host/facets/jobs.ts` (MICA-228). */
export function jobs(): Twin {
  return {
    jobs: store('jobs', [], 'jobs', []),
    jobsLoaded: store('jobs', [], 'jobsLoaded', false),
    fetchJobs: fn('jobs', [], 'fetchJobs'),
    setActiveJob: fn('jobs', [], 'setActiveJob'),
    setDuty: fn('jobs', [], 'setDuty')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('jobs', jobs as unknown as Facets['jobs']);
