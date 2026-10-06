// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { BankingBridge } from '../lib/BankingBridge';
import { PlayerFacingError } from '../lib/errors';
import type { FrameworkJob, FrameworkPlayer } from '../lib/framework/runtime';
import { configLine, isLineStaff, onLineThreadState, pushLineMessage } from '../lib/jobLines';
import { phoneNumberFrom } from '../lib/netGuard';
import { linesForJob } from '../lib/numberRegistry';
import { pageBounds } from '../lib/payload';
import type { ConversationRepository } from '../repositories/ConversationRepository';
import type { LineMessageRow, MessageRepository } from '../repositories/MessageRepository';
import { conversations } from './Conversations';
import { lineKey, messages, sendFromLine } from './Messages';
import { JOB_LINE_INBOX_MAX, jobsContract } from '@mica/shared/contracts/jobs';
import type { JobLine as ConfigLine } from '@mica/shared/ownerConfig';
import type { JobActionOutcome, JobLineMessage, JobLineThread, JobView } from '@mica/shared/types';

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

/**
 * Whether the player holding `held` may open this number's shared inbox (MICA-307): a line
 * `mica_job_lines` declares, and they are its staff by `isLineStaff`, the same predicate that
 * decides who its calls ring. A script's own line is never one: its texts are the script's.
 */
const opensInbox = (number: string, held: readonly FrameworkJob[]): boolean => {
  const line = configLine(number);
  return line !== undefined && isLineStaff(line, held);
};

/** A held job as the phone reads it: the framework's fields plus what micaOS knows about it. */
const toView = (job: FrameworkJob, held: readonly FrameworkJob[]): JobView => ({
  ...job,
  lines: linesForJob(job.name).map(({ number, label }) => ({
    number,
    label: label ?? number,
    inbox: opensInbox(number, held)
  })),
  societyBalance: job.isBoss ? BankingBridge.getSocietyBalance(job.name) : null
});

/** The list the framework holds now, active first as `getJobs` promises. */
const readJobs = (player: FrameworkPlayer): JobView[] => {
  const held = player.getJobs();
  return held.map((job) => toView(job, held));
};

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

// ─── a job line's shared inbox (MICA-307) ────────────────────────────────────

const conversationRepo = conversations.repo as ConversationRepository;
const messageRepo = messages.repo as MessageRepository;

/**
 * A thread was already waiting on an answer when its newest live row before this message is
 * the player's: no `external_sender`. None at all, or the line's, means this text starts the
 * wait, and the staff are notified (`jobLines.notifyIncoming`).
 */
onLineThreadState(async (conversationId, messageId) => {
  const previous = await messageRepo.newestLiveBefore(conversationId, messageId);
  return previous !== null && !previous.external_sender;
});

/** Read once, so the inbox pages exactly as `messages:get` does. */
const MESSAGE_PAGING = messages.resolved.paging;
if (!MESSAGE_PAGING) {
  throw new Error("jobs: a line thread pages like 'messages', which must declare paging.");
}

/**
 * The one refusal every inbox action answers with, whatever the reason: a number that is no
 * config line, a player who is not its staff right now, and a thread that is not that line's
 * all read the same. Three different answers would let a client probe which numbers are lines
 * and which conversation ids exist; one answer tells it nothing it did not already know.
 */
const lineRefused = (): PlayerFacingError =>
  new PlayerFacingError('That line is not available to you.', {
    key: 'server.jobs.lineUnavailable'
  });

/**
 * The config line a payload names, if the caller is its staff right now — and the refusal
 * otherwise. The number is matched against the registry, and staff is judged from the
 * framework's own job list for this player, never from anything the payload says.
 */
const requireLineStaff = (rawNumber: unknown, player: FrameworkPlayer): ConfigLine => {
  const number = phoneNumberFrom(rawNumber);
  const line = number ? configLine(number) : undefined;
  if (!line || !isLineStaff(line, player.getJobs())) throw lineRefused();
  return line;
};

/**
 * Refuse a conversation that is not a thread between a player and exactly this line. The id is
 * attacker-controlled (§2.9): a staff member of 911 must not read the mechanic's threads, or
 * anyone's private ones, by walking ids. `lineKeyOf` answers null for a group, a deleted thread
 * and a thread between two phones, and every one of those is refused like a wrong line.
 */
const requireLineThread = async (line: ConfigLine, conversationId: number): Promise<void> => {
  const key = await conversationRepo.lineKeyOf(conversationId);
  if (key === null || key !== lineKey({ name: null, number: line.number })) throw lineRefused();
};

/**
 * A timestamp as the phone reads it. The driver hands a `DATETIME` back as a `Date`, a string
 * or epoch milliseconds depending on its configuration; the contract says string.
 */
const isoOf = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return typeof value === 'string' ? value : '';
};

/** A thread's row from the staff side: `line` is a text sent as a line, `caller` the player's. */
const toLineMessage = (row: LineMessageRow): JobLineMessage => ({
  id: Number(row.id),
  conversation_id: Number(row.conversation_id),
  side: row.external_sender ? 'line' : 'caller',
  message: typeof row.message === 'string' ? row.message : '',
  has_attachments: Boolean(row.has_attachments),
  created_at: isoOf(row.created_at)
});

/**
 * Every thread players have opened with this line, newest activity first, at most
 * `JOB_LINE_INBOX_MAX`. One statement (`ConversationRepository.findLineThreads`).
 */
app.registerEvent(
  'lineInbox',
  async (source, cbId, data, citizenid, player): Promise<JobLineThread[]> => {
    const line = requireLineStaff(data.number, player);
    const rows = await conversationRepo.findLineThreads(
      lineKey({ name: null, number: line.number }),
      JOB_LINE_INBOX_MAX
    );
    return rows.map((row) => ({
      conversation_id: Number(row.conversation_id),
      from: row.from_number ?? null,
      last_message: typeof row.message === 'string' ? row.message : '',
      last_at: isoOf(row.created_at),
      // The newest row is the player's own: nobody has answered it yet.
      awaiting_reply: !row.external_sender
    }));
  }
);

/**
 * One thread, newest first, keyset-paged on the same bounds as `messages:get`. The thread is
 * proved to be this line's before a row of it is read; the cursor only bounds that thread.
 */
app.registerEvent('lineThread', async (source, cbId, data, citizenid, player) => {
  const line = requireLineStaff(data.number, player);
  await requireLineThread(line, data.conversation_id);
  const page = pageBounds(data, MESSAGE_PAGING);
  const { rows, nextCursor } = await messageRepo.findLinePage(data.conversation_id, page);
  return { rows: rows.map(toLineMessage), nextCursor };
});

/**
 * Answer a thread as the line, never as the staff member's own number.
 *
 * `sendFromLine` with the sender `SendMessage` would build for this line from this resource:
 * the label as the name, the number, and the line's own `blockable`. The thread is found by
 * the line's key, which is built from the number, so the reply lands in the thread the player
 * texted. The player is the thread's participant, not anybody the payload names.
 */
app.registerEvent(
  'lineReply',
  async (source, cbId, data, citizenid, player): Promise<JobLineMessage> => {
    const line = requireLineStaff(data.number, player);
    await requireLineThread(line, data.conversation_id);
    // After the line checks, so a stranger still learns nothing but "not available". The
    // contract's `min: 1` counts spaces; the refusal is `messages:send`'s, word for word.
    if (!data.message.trim()) {
      throw new PlayerFacingError('A message body or an attachment is required.', {
        key: 'server.messages.bodyRequired'
      });
    }
    const recipient = await conversationRepo.lineThreadPlayer(data.conversation_id);
    if (!recipient) throw lineRefused();

    const sent = await sendFromLine(
      recipient,
      { name: line.label ?? line.number, number: line.number, blockable: line.blockable },
      data.message,
      []
    );

    // The others on shift see the thread move; the one who answered already knows.
    pushLineMessage(line, sent.conversationId, source);

    return {
      id: sent.messageId,
      conversation_id: sent.conversationId,
      side: 'line',
      message: data.message,
      has_attachments: false,
      created_at: new Date().toISOString()
    };
  }
);
