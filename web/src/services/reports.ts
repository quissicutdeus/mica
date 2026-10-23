// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, writable } from 'svelte/store';
import { call } from '../nui/call';
import { reportsContract } from '@mica/shared/contracts/reports';
import type { ActionOutput } from '@mica/shared/contract';
import type { Report } from '@mica/shared/types';
import type { SubmitReportInput } from '@mica/sdk';

/**
 * The moderation queue, and the badge that counts it.
 *
 * The count is derived from the pending list rather than being decremented on open.
 * That distinction is the whole point: a report is outstanding until somebody decides
 * about it, so visiting the app must not clear the badge the way opening Mail clears
 * an unread count. Nothing here is marked "seen".
 */

export const pendingReports = writable<Report[]>([]);
export const resolvedReports = writable<Report[]>([]);

/** Drives the home-screen badge. Falls to zero only when the queue empties. */
export const pendingReportCount = derived(pendingReports, ($pending) => $pending.length);

const asReports = (value: unknown): Report[] => (Array.isArray(value) ? (value as Report[]) : []);

/**
 * A failed read keeps the last list rather than emptying it: an emptied queue zeroes the
 * badge and tells an admin there is nothing waiting. A non-admin is refused server-side and
 * keeps the empty list it started with, which is still the right thing to show.
 */
export const loadPendingReports = async (): Promise<void> => {
  try {
    pendingReports.set(asReports(await call(reportsContract, 'queue', undefined)));
  } catch (error) {
    console.warn('Could not load the report queue; keeping the last one.', error);
  }
};

export const loadReportHistory = async (): Promise<void> => {
  try {
    resolvedReports.set(asReports(await call(reportsContract, 'history', undefined)));
  } catch (error) {
    console.warn('Could not load report history; keeping the last one.', error);
  }
};

/** Resolve, then re-read both lists so the badge and history agree with the server. */
export const resolveReport = async (id: number, action: 'moderate' | 'dismiss'): Promise<void> => {
  await call(reportsContract, 'resolve', { id, action });
  await Promise.all([loadPendingReports(), loadReportHistory()]);
};

/** Undo a decision. Restores hidden content as well as reopening the report. */
export const reopenReport = async (id: number): Promise<void> => {
  await call(reportsContract, 'reopen', { id });
  await Promise.all([loadPendingReports(), loadReportHistory()]);
};

/** One earlier version of a reported row's content, as `reports:versions` answers it. */
export type ReportVersion = ActionOutput<typeof reportsContract, 'versions'>[number];

/**
 * Every earlier version of the reported row's content (MICA-430), **newest first** — the
 * server answers oldest first, and staff reading an edit history want what changed last on
 * top. Admin-only server-side, like the queue.
 *
 * No default and no store: a failed read rejects, so the caller can say the history could
 * not be loaded rather than telling staff the row was never edited. An empty list is only
 * ever the server's own answer.
 */
export const loadReportVersions = async (id: number): Promise<ReportVersion[]> => {
  const versions: unknown = await call(reportsContract, 'versions', { id });
  // Not a list is not an answer: shown as the error, never as "never edited".
  if (!Array.isArray(versions)) throw new Error('The edit history reply was not a list.');
  return [...(versions as ReportVersion[])].reverse();
};

/**
 * File a report against a row. Anyone may call it; the queue that reads it is admin-only.
 * Throws with the server's message so the caller can toast it.
 */
export const submitReport = async (input: SubmitReportInput): Promise<void> => {
  await call(reportsContract, 'create', input);
};
