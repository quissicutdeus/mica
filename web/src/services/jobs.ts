// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { call, callOr } from '../nui/call';
import { jobsContract } from '@mica/shared/contracts/jobs';
import type { JobActionOutcome, JobView } from '@mica/shared/types';

/**
 * The jobs a player holds (MICA-228), behind `useJobs()`.
 *
 * Its own file rather than a corner of `services/account.ts`, for the reason
 * `services/bank.ts` gives: `account` is the permission every balance-showing add-on
 * declares, and switching the active job changes what every other resource on the
 * server thinks the player is doing. That is not a read, so it lives behind `jobs`.
 */

export const jobs = writable<JobView[]>([]);

/**
 * False until the first fetch has come back — the same signal `transactionsLoaded`
 * carries, for the same reason: an empty list and "you hold no jobs" are two different
 * statements, and only one of them is true on the first frame.
 */
export const jobsLoaded = writable(false);

export const fetchJobs = async () => {
  try {
    jobs.set(await callOr(jobsContract, 'getJobs', undefined, [] as JobView[]));
  } catch (error) {
    console.error('Failed to fetch jobs:', error);
  } finally {
    jobsLoaded.set(true);
  }
};

/**
 * Both setters answer with the re-read list on success and it lands in `jobs` here,
 * before the caller sees the outcome, so nobody has to fetch again. A refusal is a
 * value, not an exception: the caller renders the reason.
 */
const apply = (outcome: JobActionOutcome): JobActionOutcome => {
  if (outcome.ok) jobs.set(outcome.jobs);
  return outcome;
};

export const setActiveJob = async (name: string): Promise<JobActionOutcome> =>
  apply(await call(jobsContract, 'setActiveJob', { name }));

export const setDuty = async (name: string, onDuty: boolean): Promise<JobActionOutcome> =>
  apply(await call(jobsContract, 'setDuty', { name, onDuty }));
