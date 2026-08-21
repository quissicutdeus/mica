import { derived, writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import type { Report } from '@shared/types';

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

const asReports = (value: unknown): Report[] => (Array.isArray(value) ? value : []);

export const loadPendingReports = async (): Promise<void> => {
  // A non-admin is refused server-side; an empty queue is the right thing to show.
  const rows = await fetchNui<Report[]>('getReportQueue', {}).catch(() => []);
  pendingReports.set(asReports(rows));
};

export const loadReportHistory = async (): Promise<void> => {
  const rows = await fetchNui<Report[]>('getReportHistory', {}).catch(() => []);
  resolvedReports.set(asReports(rows));
};

/** Resolve, then re-read both lists so the badge and history agree with the server. */
export const resolveReport = async (id: number, action: 'moderate' | 'dismiss'): Promise<void> => {
  const res = await fetchNui<{ error?: string }>('resolveReport', { id, action });
  if (res?.error) throw new Error(res.error);
  await Promise.all([loadPendingReports(), loadReportHistory()]);
};

/** Undo a decision. Restores hidden content as well as reopening the report. */
export const reopenReport = async (id: number): Promise<void> => {
  const res = await fetchNui<{ error?: string }>('reopenReport', { id });
  if (res?.error) throw new Error(res.error);
  await Promise.all([loadPendingReports(), loadReportHistory()]);
};

export interface SubmitReportInput {
  targetTable: string;
  targetId: number;
  category: string;
  note?: string;
}

/**
 * File a report against a row. Anyone may call it; the queue that reads it is admin-only.
 * Throws with the server's message so the caller can toast it.
 */
export const submitReport = async (input: SubmitReportInput): Promise<void> => {
  const res = await fetchNui<{ ok?: boolean; error?: string }>('createReport', input);
  if (res?.error) throw new Error(res.error);
};
