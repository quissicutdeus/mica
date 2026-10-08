// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JobActionOutcome, JobLineMessage, JobLineThread, JobView } from '@mica/shared/types';
import { mockJobLineMessages, mockJobLineThreads, mockJobs } from '../data';
import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  /**
   * Jobs (MICA-228). Mirrors `server/services/Jobs.ts` refusal for refusal, so the Jobs
   * app's copy for each is reachable in a browser: a name outside the held list is
   * `unknown_job`, duty on a job with no duty notion is `unsupported`, duty on a job
   * that is not active is `not_active`. Each success answers the re-read list, the way
   * the server does, so the app never has to fetch again.
   */
  'jobs:getJobs': (): JobView[] => mockJobs,
  'jobs:setActiveJob': (payload?: { name?: string }): JobActionOutcome => {
    const job = mockJobs.find((j) => j.name === payload?.name);
    if (!job) return { ok: false, reason: 'unknown_job' };
    for (const j of mockJobs) j.active = j === job;
    return { ok: true, jobs: mockJobs };
  },
  'jobs:setDuty': (payload?: { name?: string; onDuty?: boolean }): JobActionOutcome => {
    const job = mockJobs.find((j) => j.name === payload?.name);
    if (!job) return { ok: false, reason: 'unknown_job' };
    if (job.onDuty === null) return { ok: false, reason: 'unsupported' };
    if (!job.active) return { ok: false, reason: 'not_active' };
    job.onDuty = payload?.onDuty === true;
    return { ok: true, jobs: mockJobs };
  },

  /**
   * A job line's shared inbox (MICA-307). The server answers only the line's staff and only
   * a thread between a player and that line; the mock keys both off `mockJobLineThreads`,
   * so a number or a thread it does not hold reads as empty, the way a refusal leaves the
   * app with nothing to show.
   */
  'jobs:lineInbox': (payload?: { number?: string }): JobLineThread[] =>
    mockJobLineThreads[payload?.number ?? ''] ?? [],
  'jobs:lineThread': (payload?: {
    number?: string;
    conversation_id?: number;
  }): { rows: JobLineMessage[]; nextCursor: number | null } => {
    const held = (mockJobLineThreads[payload?.number ?? ''] ?? []).some(
      (thread) => thread.conversation_id === payload?.conversation_id
    );
    return {
      rows: held ? (mockJobLineMessages[payload?.conversation_id ?? 0] ?? []) : [],
      nextCursor: null
    };
  },
  'jobs:lineReply': (payload?: {
    number?: string;
    conversation_id?: number;
    message?: string;
  }): JobLineMessage => {
    const thread = (mockJobLineThreads[payload?.number ?? ''] ?? []).find(
      (row) => row.conversation_id === payload?.conversation_id
    );
    if (!thread) throw new Error('That thread is not on this line.');
    const now = new Date().toISOString();
    const reply: JobLineMessage = {
      id: Date.now(),
      conversation_id: thread.conversation_id,
      side: 'line',
      message: payload?.message ?? '',
      has_attachments: false,
      created_at: now
    };
    (mockJobLineMessages[thread.conversation_id] ??= []).unshift(reply);
    thread.last_message = reply.message;
    thread.last_at = now;
    thread.awaiting_reply = false;
    return reply;
  }
};
