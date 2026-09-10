// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { BankingBridge } from '../lib/BankingBridge';
import type { FrameworkJob, FrameworkPlayer } from '../lib/framework/runtime';
import { linesForJob } from '../lib/numberRegistry';
import { jobsContract } from '@mica/shared/contracts/jobs';
import type { JobActionOutcome, JobView } from '@mica/shared/types';

/**
 * Jobs: the framework's answer about what a player does, and the two things a phone may
 * change about it (MICA-228).
 *
 * No repository and no `defineService` declaration, for Bank's reason: the data belongs to
 * the framework, is read through `FrameworkPlayer` (MICA-227), and any copy micaOS kept
 * would be stale the moment a job script touched the real one.
 *
 * The §2.9 line for this service is one rule: **a `name` in a payload is only ever compared
 * against the player's own list.** It is never handed to the framework's setters, and never
 * to the banking bridge, unless it is a name the framework already says this player holds.
 * `getSocietyBalance` in particular takes a job name as an account key on somebody else's
 * export, so it is read only for a boss grade and only under the framework's own name for
 * that job — never the client's spelling of it.
 */
const app = new ServiceEndpoint<never, typeof jobsContract>('jobs', null, {
  app: 'jobs',
  contract: jobsContract,
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

/** A held job as the phone reads it: the framework's fields plus what micaOS knows about it. */
const toView = (job: FrameworkJob): JobView => ({
  ...job,
  lines: linesForJob(job.name).map(({ number, label }) => ({ number, label: label ?? number })),
  societyBalance: job.isBoss ? BankingBridge.getSocietyBalance(job.name) : null
});

/** The list the framework holds now, active first as `getJobs` promises. */
const readJobs = (player: FrameworkPlayer): JobView[] => player.getJobs().map(toView);

/** The held job with this name, from the framework's list, or `undefined` for any other string. */
const heldJob = (player: FrameworkPlayer, name: string): FrameworkJob | undefined =>
  player.getJobs().find((job) => job.name === name);

app.registerEvent('getJobs', async (source, cbId, data, citizenid, player) => readJobs(player));

app.registerEvent(
  'setActiveJob',
  async (source, cbId, data, citizenid, player): Promise<JobActionOutcome> => {
    const job = heldJob(player, data.name);
    if (!job) return { ok: false, reason: 'unknown_job' };
    // `job.name` rather than `data.name`: equal here, and the framework's copy is the one
    // that is handed on so the rule above holds by construction rather than by comparison.
    if (!player.setActiveJob(job.name)) return { ok: false, reason: 'refused' };
    return { ok: true, jobs: readJobs(player) };
  }
);

app.registerEvent(
  'setDuty',
  async (source, cbId, data, citizenid, player): Promise<JobActionOutcome> => {
    const job = heldJob(player, data.name);
    if (!job) return { ok: false, reason: 'unknown_job' };
    // Ordered so the answer names the real obstacle: a job with no duty notion is
    // `unsupported` whether or not it is active, and only then does activity matter.
    if (job.onDuty === null) return { ok: false, reason: 'unsupported' };
    if (!job.active) return { ok: false, reason: 'not_active' };
    if (!player.setDuty(job.name, data.onDuty)) return { ok: false, reason: 'refused' };
    return { ok: true, jobs: readJobs(player) };
  }
);
