// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { JobActionOutcome, JobLineMessage, JobLineThread, JobView } from '../types';
import { MESSAGE_BODY_MAX } from './messages';

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
    },

    /**
     * A job line's shared inbox (MICA-307): the threads players have opened with one of the
     * `mica_job_lines` numbers, newest activity first, at most `JOB_LINE_INBOX_MAX`.
     *
     * Every caller keeps their own thread with the line, exactly as MICA-275 built it; the
     * inbox is the staff's view across all of them. The server answers only a caller who is
     * staff of that line **right now**, judged from the framework (active job, not off duty),
     * and only for a line `mica_job_lines` declares: a script's own line is the script's to
     * answer through `onMessage`. `number` is matched against the registry, never trusted.
     */
    lineInbox: {
      input: s.object({ number: s.string({ min: 1, max: 32 }) }),
      output: responseType<JobLineThread[]>()
    },

    /**
     * One thread in that inbox, newest first, keyset-paged like `messages:get`. The server
     * checks the thread is one between a player and this line before reading a row of it.
     */
    lineThread: {
      input: s.object({
        number: s.string({ min: 1, max: 32 }),
        conversation_id: s.positiveInt(),
        cursor: s.positiveInt().nullable().optional(),
        limit: s.positiveInt().optional()
      }),
      output: responseType<{ rows: JobLineMessage[]; nextCursor: number | null }>()
    },

    /**
     * Answer a thread as the line, never as the staff member's own number: it lands in the
     * player's Messages exactly as `SendMessage` from that line would (`sendFromLine`).
     * Text only.
     */
    lineReply: {
      input: s.object({
        number: s.string({ min: 1, max: 32 }),
        conversation_id: s.positiveInt(),
        message: s.string({ min: 1, max: MESSAGE_BODY_MAX })
      }),
      output: responseType<JobLineMessage>()
    }
  }
});

/** How many threads `lineInbox` answers with at most. */
export const JOB_LINE_INBOX_MAX = 50;
