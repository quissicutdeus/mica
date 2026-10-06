// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import { t, useAppEvents, useService } from '@mica/sdk';
import type { ActionInput, ActionOutput, ContractAction } from '@mica/shared/contract';
import type { jobsContract } from '@mica/shared/contracts/jobs';
import type { JobLine, JobLineMessage, JobLineThread } from '@mica/shared/types';

/**
 * A job line's shared inbox (MICA-307): the staff side of every thread players have opened
 * with one of the owner's `mica_job_lines` numbers.
 *
 * In the app rather than in core's `services/`, for the reason `apps/notes/store.ts` gives:
 * an app reaches its own service through `useService`, and the three actions ride the same
 * generic `svc` door the typed `call(jobsContract, …)` does, so the contract still governs
 * what crosses. `ask` below keeps the contract's input and output types on that door.
 *
 * One line and one thread are open at a time — the app is resident and has one screen — so
 * this holds exactly that, and every answer is checked against what is still open before it
 * lands: a slow `lineInbox` for a line the player has already backed out of must not paint
 * over the next one.
 */

type Jobs = typeof jobsContract;

const ask = <A extends ContractAction<Jobs>>(
  action: A,
  input: ActionInput<Jobs, A>
): Promise<ActionOutput<Jobs, A>> => useService('jobs').call<ActionOutput<Jobs, A>>(action, input);

/** The line whose inbox is on screen, or null on the job list. */
export const openLine = writable<JobLine | null>(null);
export const inbox = writable<JobLineThread[]>([]);
/** False until the first answer for the open line, so "no threads" is never a guess. */
export const inboxLoaded = writable(false);
/**
 * The last `lineInbox` failed. After a refusal the cached rows are gone too, so the inbox
 * reads as unavailable; after any other failure the rows stay and this only records it.
 */
export const inboxFailed = writable(false);

/** The thread on screen, by `conversation_id`, or null on the inbox. */
export const openThreadId = writable<number | null>(null);
/** Oldest first, the order a thread reads in; the server pages newest first. */
export const thread = writable<JobLineMessage[]>([]);
export const threadLoaded = writable(false);
/** The keyset cursor for the next older page, or null when the thread is fully loaded. */
export const threadCursor = writable<number | null>(null);
export const threadLoadingOlder = writable(false);

const THREAD_PAGE = 30;

const lineNumber = (): string | null => get(openLine)?.number ?? null;

/**
 * Whether a failed call was the server refusing the line, rather than the round trip failing.
 *
 * The server answers every inbox action with one refusal — not this line's staff right now, no
 * such line, not this line's thread all read the same (`lineRefused` in
 * `server/services/Jobs.ts`), so a client cannot probe which is which. `call` hands that back
 * as a plain `Error` whose message `fetchNui` has already translated from the reply's key
 * (`server.jobs.lineUnavailable`) and dropped the key itself, so the message is the one thing
 * there is to compare. Against the translation the phone would have produced, and the English
 * the server sends beside it for a catalog that lacks the key. A timeout, a missing server half
 * or the generic "something went wrong" matches neither, and keeps the cached rows.
 */
const LINE_REFUSED_KEY = 'server.jobs.lineUnavailable';
const LINE_REFUSED_ENGLISH = 'That line is not available to you.';
export const isLineRefusal = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.message === get(t)(LINE_REFUSED_KEY) || error.message === LINE_REFUSED_ENGLISH;
};

/**
 * The server says this player may not use the line any more — off duty, a job changed. Every
 * row cached for it is a view of something they can no longer act on, so all of it goes and
 * the inbox shows itself unavailable, rather than a live-looking list whose every reply fails.
 */
function refuseLine(number: string): void {
  if (lineNumber() !== number) return;
  closeThread();
  inbox.set([]);
  inboxFailed.set(true);
  inboxLoaded.set(true);
}

/**
 * The newest `lineInbox` request. The inbox is replaced whole by each answer, so an older
 * answer that lands after a newer one — a push refresh racing the foreground read — would
 * paint the stale list over the fresh one. Only the newest request's answer is applied.
 */
let inboxRequest = 0;

export async function loadInbox(): Promise<void> {
  const number = lineNumber();
  if (!number) return;
  const mine = ++inboxRequest;
  try {
    const rows = await ask('lineInbox', { number });
    if (mine !== inboxRequest || lineNumber() !== number) return;
    inbox.set(rows ?? []);
    inboxFailed.set(false);
    inboxLoaded.set(true);
  } catch (error) {
    if (mine !== inboxRequest || lineNumber() !== number) return;
    if (isLineRefusal(error)) {
      refuseLine(number);
      return;
    }
    console.error('Failed to load the line inbox:', error);
    inboxFailed.set(true);
    inboxLoaded.set(true);
  }
}

export function openInbox(line: JobLine): void {
  if (!line.inbox) return;
  closeThread();
  openLine.set(line);
  inbox.set([]);
  inboxLoaded.set(false);
  inboxFailed.set(false);
  void loadInbox();
}

export function closeInbox(): void {
  closeThread();
  openLine.set(null);
  inbox.set([]);
  inboxLoaded.set(false);
  inboxFailed.set(false);
}

/** Merge a page into what is loaded: a row already held is replaced, the rest kept, by id. */
const merge = (held: JobLineMessage[], page: JobLineMessage[]): JobLineMessage[] => {
  const byId = new Map(held.map((row) => [row.id, row]));
  for (const row of page) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.id - b.id);
};

/**
 * Which opening of a thread is on screen. Bumped on every open and close, so an answer for a
 * thread the player has left — or left and come back to — never lands in the one now showing.
 */
let threadEpoch = 0;

/** True while `epoch` is still the thread on screen, on the line it was asked for. */
const stillOpen = (epoch: number, number: string): boolean =>
  epoch === threadEpoch && lineNumber() === number;

/**
 * The newest page, merged by id into what is loaded — never replacing it.
 *
 * Both the first load and a push refresh ask for the same page, and their answers can land in
 * either order. Replacing on the first load meant an open that answered after a refresh threw
 * away the row the refresh had just brought in. Merging makes the order irrelevant: the thread
 * was emptied when it opened, so the first answer to land fills it, and the other adds what it
 * has that the first did not. Only the opening load sets the cursor, since only it answers
 * where the older pages begin.
 */
async function fetchNewest(mode: 'open' | 'refresh'): Promise<void> {
  const number = lineNumber();
  const conversationId = get(openThreadId);
  if (!number || conversationId === null) return;
  const epoch = threadEpoch;
  try {
    const reply = await ask('lineThread', {
      number,
      conversation_id: conversationId,
      limit: THREAD_PAGE
    });
    if (!stillOpen(epoch, number)) return;
    thread.update((held) => merge(held, [...(reply?.rows ?? [])].reverse()));
    if (mode === 'open') threadCursor.set(reply?.nextCursor ?? null);
    threadLoaded.set(true);
  } catch (error) {
    if (!stillOpen(epoch, number)) return;
    if (isLineRefusal(error)) {
      refuseLine(number);
      return;
    }
    console.error('Failed to load the line thread:', error);
    threadLoaded.set(true);
  }
}

/** Re-read the open thread's newest page into what is loaded — on a push, or on foreground. */
export const refreshThread = (): Promise<void> => fetchNewest('refresh');

export function openThread(conversationId: number): void {
  threadEpoch++;
  openThreadId.set(conversationId);
  thread.set([]);
  threadCursor.set(null);
  threadLoaded.set(false);
  threadLoadingOlder.set(false);
  void fetchNewest('open');
}

export function closeThread(): void {
  threadEpoch++;
  openThreadId.set(null);
  thread.set([]);
  threadCursor.set(null);
  threadLoaded.set(false);
  threadLoadingOlder.set(false);
}

/** The next older page, keyset on the cursor the last page answered with. */
export async function loadOlder(): Promise<void> {
  const number = lineNumber();
  const conversationId = get(openThreadId);
  const cursor = get(threadCursor);
  if (!number || conversationId === null || cursor === null || get(threadLoadingOlder)) return;
  const epoch = threadEpoch;
  threadLoadingOlder.set(true);
  try {
    const reply = await ask('lineThread', {
      number,
      conversation_id: conversationId,
      cursor,
      limit: THREAD_PAGE
    });
    if (!stillOpen(epoch, number)) return;
    thread.update((held) => merge(held, [...(reply?.rows ?? [])].reverse()));
    threadCursor.set(reply?.nextCursor ?? null);
  } catch (error) {
    if (!stillOpen(epoch, number)) return;
    if (isLineRefusal(error)) {
      refuseLine(number);
      return;
    }
    console.error('Failed to load older line messages:', error);
  } finally {
    if (stillOpen(epoch, number)) threadLoadingOlder.set(false);
  }
}

/**
 * Answer a thread as the line. Throws on any failure so `useAppAction`'s `run` can toast it
 * and the caller keeps the draft. A refusal also clears the line first (`refuseLine`), so the
 * toast lands on an inbox that says why, not on a thread that still looks answerable. On
 * success the returned row — the newest — is merged in and the inbox row stops waiting, the
 * way the server's own re-read would show it.
 */
export async function reply(conversationId: number, message: string): Promise<JobLineMessage> {
  const number = lineNumber();
  if (!number) throw new Error('No line is open.');
  const epoch = threadEpoch;
  let row: JobLineMessage;
  try {
    row = await ask('lineReply', { number, conversation_id: conversationId, message });
  } catch (error) {
    if (isLineRefusal(error)) refuseLine(number);
    throw error;
  }
  if (stillOpen(epoch, number) && get(openThreadId) === conversationId) {
    thread.update((held) => merge(held, [row]));
  }
  if (lineNumber() === number) {
    inbox.update((rows) =>
      rows.map((entry) =>
        entry.conversation_id === conversationId
          ? { ...entry, last_message: row.message, last_at: row.created_at, awaiting_reply: false }
          : entry
      )
    );
  }
  return row;
}

/**
 * `line_message`: a player wrote to a line, or a colleague answered as it. Subscribed here at
 * module scope rather than in a component, so a push that lands while the inbox is mounted
 * and the thread is not (or the reverse) is still seen (`nui-endpoint`). The payload names
 * what changed; the server says what it now holds, so this re-reads rather than patching.
 */
useAppEvents('jobs').on<{ number?: unknown; conversation_id?: unknown }>(
  'line_message',
  ({ payload }) => {
    if (typeof payload?.number !== 'string' || payload.number !== lineNumber()) return;
    void loadInbox();
    if (payload.conversation_id === get(openThreadId)) void refreshThread();
  }
);
