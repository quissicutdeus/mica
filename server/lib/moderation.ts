import { Database } from './Database';
import { AuditLogger } from './AuditLogger';
import type { ReportCategory } from '@shared/types';

/**
 * Hiding someone else's content, and the allowlist that makes it safe.
 *
 * `moderated` has been a declared status on seven tables since those tables existed and
 * nothing ever wrote it. This is what writes it.
 *
 * A soft status change rather than a delete: the generic read path already filters
 * `status = 'active'`, so the row vanishes from every app at once while staying in the
 * database for the audit trail to point at. Deleting it would leave the ledger
 * referring to nothing.
 */

/**
 * Tables a report may name, and how to describe a row from each in the review queue.
 *
 * An allowlist because `target_table` arrives in a NUI payload and ends up interpolated
 * into SQL — MySQL cannot parameterise an identifier, so the only safe move is to
 * refuse anything not on this list (AGENTS.md §2.9). Adding a reportable type is a
 * deliberate edit here.
 */
export const REPORTABLE = {
  gphone_messages: { label: 'Message', previewColumn: 'message' },
  gphone_photos: { label: 'Photo', previewColumn: 'image' }
} as const;

export type ReportableTable = keyof typeof REPORTABLE;

export const isReportableTable = (table: unknown): table is ReportableTable =>
  typeof table === 'string' && Object.prototype.hasOwnProperty.call(REPORTABLE, table);

export const REPORT_CATEGORIES: readonly ReportCategory[] = [
  'spam',
  'harassment',
  'threats',
  'sexual',
  'impersonation',
  'other'
] as const;

export const isReportCategory = (value: unknown): value is ReportCategory =>
  typeof value === 'string' && (REPORT_CATEGORIES as readonly string[]).includes(value);

/** A note is attacker-controlled prose headed for an admin's screen. Cap it. */
export const MAX_NOTE_LENGTH = 500;

export interface TargetSummary {
  exists: boolean;
  /** The row's author, so the queue can say who is being reported. */
  citizenid?: string;
  /** A short excerpt. Truncated — a photo's column holds a base64 image. */
  preview?: string;
  status?: string;
}

/**
 * Describe a reported row for the queue.
 *
 * Read at review time and stored on the report, so the queue still says what was
 * reported after the content has been moderated or the author has deleted it.
 */
export const summariseTarget = async (
  table: ReportableTable,
  id: number
): Promise<TargetSummary> => {
  const { previewColumn } = REPORTABLE[table];
  // `table` and `previewColumn` come from the allowlist above, never from the payload.
  const row = await Database.single<Record<string, unknown>>(
    `SELECT \`citizenid\`, \`status\`, \`${previewColumn}\` AS preview
     FROM \`${table}\` WHERE \`id\` = ?`,
    [id]
  );

  if (!row) return { exists: false };

  const raw = row.preview;
  const preview = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);

  return {
    exists: true,
    citizenid: typeof row.citizenid === 'string' ? row.citizenid : undefined,
    status: typeof row.status === 'string' ? row.status : undefined,
    // A photo's preview column is a base64 image; nobody needs 200KB of it in a list.
    preview: preview.slice(0, 280)
  };
};

/**
 * Mark a row moderated.
 *
 * Unscoped by necessity — the whole point is acting on content the caller does not own
 * — so the authorisation has to happen before this is called. It is exported from a
 * module that does nothing else, rather than added to a repository, so that is obvious
 * at the call site.
 */
export const setTargetStatus = async (
  table: ReportableTable,
  id: number,
  status: 'moderated' | 'active',
  actorCitizenid: string,
  reason: string
): Promise<boolean> => {
  // `status` is a literal from this function's own signature, never a payload.
  const ok = await Database.update(`UPDATE \`${table}\` SET \`status\` = ? WHERE \`id\` = ?`, [
    status,
    id
  ]);

  if (ok) {
    await AuditLogger.log({
      citizenid: actorCitizenid,
      action: status === 'moderated' ? 'moderated' : 'unmoderated',
      service: 'reports',
      method: status === 'moderated' ? 'resolve' : 'reopen',
      targetId: id,
      targetTable: table,
      details: reason
    });
  }

  return ok;
};

export const moderateTarget = (table: ReportableTable, id: number, actor: string, reason: string) =>
  setTargetStatus(table, id, 'moderated', actor, reason);

/**
 * Put moderated content back.
 *
 * Restores to `active` rather than to whatever it was before, because the previous
 * status is not recorded anywhere — and the only status a moderated row can have had is
 * active, since a deleted row is not visible to report in the first place.
 */
export const restoreTarget = (table: ReportableTable, id: number, actor: string, reason: string) =>
  setTargetStatus(table, id, 'active', actor, reason);
