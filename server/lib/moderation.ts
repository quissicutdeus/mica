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

/** How to describe a row from a reportable table in the review queue. */
export interface ReportableDefinition {
  /** What a moderator sees this called. */
  label: string;
  /** The column to excerpt. Must exist on the table, alongside `citizenid` and `status`. */
  previewColumn: string;
}

/**
 * Tables a report may name, and how to describe a row from each.
 *
 * Still an allowlist, and still the security boundary: `target_table` arrives in a NUI
 * payload and ends up interpolated into SQL, because MySQL cannot parameterise an
 * identifier, so refusing anything not on this list is the only safe move (§2.9).
 *
 * **Populated by declaration, not by a literal here.** It used to be a hardcoded object,
 * which meant this file — core, in `server/lib/` — named `gphone_blabber` and
 * `gphone_blabber_dms`. Blabber is `core: false`: an add-on. Core naming an add-on is the
 * dependency pointing the wrong way, and it had a concrete cost rather than an aesthetic
 * one — a third-party app installed from the Store could not make its content reportable
 * at all, because doing so meant editing this file and the SDK.
 *
 * A service opts in through `defineService`, the same way `registerService` already
 * collects service names. The allowlist is no weaker for it: nothing reaches this map
 * except a declaration in server code, and a payload still has to match one.
 */
const reportable = new Map<string, ReportableDefinition>();

/**
 * Declare a table reportable. Called from `defineService`; not something to call by hand.
 *
 * Registration happens at import time, and every service is imported by
 * `server/services/index.ts` before any report can be handled — so the map is complete
 * long before `ServiceEndpoint` dispatches anything at it.
 */
export const registerReportable = (table: string, definition: ReportableDefinition): void => {
  reportable.set(table, definition);
};

/** Test seam, and the reason `REPORTABLE` is a function rather than the map itself. */
export const REPORTABLE = (): Readonly<Record<string, ReportableDefinition>> =>
  Object.fromEntries(reportable);

/**
 * A table name that has been declared reportable.
 *
 * A plain string rather than a union now, because the set is open — an add-on can join it,
 * and a closed union is exactly what stopped one from doing so. `isReportableTable` is the
 * check, and it runs against the registry rather than against the type.
 */
export type ReportableTable = string;

export const isReportableTable = (table: unknown): table is ReportableTable =>
  typeof table === 'string' && reportable.has(table);

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
  const definition = reportable.get(table);
  if (!definition) return { exists: false };
  const { previewColumn } = definition;
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
const setTargetStatus = async (
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
