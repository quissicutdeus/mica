// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { AuditLogger } from './AuditLogger';
import { PlayerFacingError } from './errors';
import { isDuplicateKey } from './sqlErrors';
import { contentContext, encryptedColumn, isSealed, openContent } from './contentCipher';
import type { ReportCategory } from '@mica/shared/types';

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
  /**
   * What the reporter was called where they saw the row, when that is not their character
   * (MICA-254): an alias in a Dark Chat channel. Asked once the report has passed its
   * visibility check, and written to `mica_reports.reporter_label`, so staff read who reported
   * it as the room knew them. Null when there is nothing to say.
   */
  reporterLabel?: (targetId: number, citizenid: string) => Promise<string | null>;
}

/**
 * Tables a report may name, and how to describe a row from each.
 *
 * Still an allowlist, and still the security boundary: `target_table` arrives in a NUI
 * payload and ends up interpolated into SQL, because MySQL cannot parameterise an
 * identifier, so refusing anything not on this list is the only safe move (§2.9).
 *
 * **Populated by declaration, not by a literal here.** It used to be a hardcoded object,
 * which meant this file — core, in `server/lib/` — named `mica_blabber` and
 * `mica_blabber_dms`. Blabber is `core: false`: an add-on. Core naming an add-on is the
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
  /**
   * A preview column sealed at rest (MICA-165) opens here, in the application, off the row's
   * own context — so its scope columns are selected too, under their own names, beside the
   * `citizenid` already here. The snapshot the report keeps is then sealed again, bound to the
   * report rather than to the content.
   */
  const sealed = encryptedColumn(table, previewColumn);
  const scope = (sealed?.scope ?? []).map((column) => `, \`${column}\``).join('');
  // `table`, `previewColumn` and the scope come from declarations, never from the payload.
  const row = await Database.single<Record<string, unknown>>(
    `SELECT \`citizenid\`, \`status\`, \`${previewColumn}\` AS preview${scope}
     FROM \`${table}\` WHERE \`id\` = ?`,
    [id]
  );

  if (!row) return { exists: false };

  const raw = row.preview;
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  const preview =
    sealed && isSealed(text) ? openContent(contentContext(sealed, row), text, id) : text;

  return {
    exists: true,
    citizenid: typeof row.citizenid === 'string' ? row.citizenid : undefined,
    status: typeof row.status === 'string' ? row.status : undefined,
    // A photo's preview column is a base64 image; nobody needs 200KB of it in a list.
    preview: preview.slice(0, 280)
  };
};

/** The status a takedown holds a row at, and the one status a restore never writes back. */
const MODERATED = 'moderated';

/** Every `statuses` list declares lowercase words; anything else did not come off a row. */
const STATUS_SHAPE = /^[a-z_]{1,32}$/;

/** A status a restore may put a row back to: a status word, and not `moderated` itself. */
export const isRestorableStatus = (value: unknown): value is string =>
  typeof value === 'string' && STATUS_SHAPE.test(value) && value !== MODERATED;

/**
 * How many times a takedown re-reads a row whose status moved between its read and its write
 * before giving up. One retry covers an author deleting at the same moment; three is generous.
 */
const MODERATE_ATTEMPTS = 3;

/**
 * Move a row from one status to another, **only if it is still on the one the caller read**.
 *
 * Unscoped by necessity — the whole point is acting on content the caller does not own
 * — so the authorisation has to happen before this is called. It is exported from a
 * module that does nothing else, rather than added to a repository, so that is obvious
 * at the call site.
 *
 * Both statuses are bound, never interpolated: `from` was read off the row, `to` is either
 * `moderated` or a status a report recorded off the same row (MICA-386).
 */
const moveStatus = async (
  table: ReportableTable,
  id: number,
  from: string,
  to: string
): Promise<boolean> => {
  try {
    return await Database.update(
      `UPDATE \`${table}\` SET \`status\` = ? WHERE \`id\` = ? AND \`status\` = ?`,
      [to, id, from]
    );
  } catch (error) {
    /**
     * A unique key built on `status` refusing the move (MICA-330). `mica_blabber`'s
     * `account_mouth_key` frees a deleted mouth's slot, so a mouth reported while live, then
     * deleted by its author and mouthed again, cannot be marked moderated: that would be two
     * mouths of one Blab holding the key. Said in words, because the admin acting on it is the
     * one person who can do something else — dismiss the report, or act on the newer row.
     */
    if (!isDuplicateKey(error)) throw error;
    const conflict = new PlayerFacingError(
      'That content clashes with a newer copy its author posted, so its status cannot change.',
      { key: 'server.reports.targetConflict' }
    );
    (conflict as PlayerFacingError & { cause?: unknown }).cause = error;
    throw conflict;
  }
};

const audit = (
  table: ReportableTable,
  id: number,
  takedown: boolean,
  actorCitizenid: string,
  reason: string
) =>
  AuditLogger.log({
    citizenid: actorCitizenid,
    action: takedown ? 'moderated' : 'unmoderated',
    service: 'reports',
    method: takedown ? 'resolve' : 'reopen',
    targetId: id,
    targetTable: table,
    details: reason
  });

/**
 * Mark a row moderated, and answer **the status the takedown replaced** (MICA-386) — or null
 * when there is no such row, and nothing was written.
 *
 * The caller keeps the answer, because a reopen has to put back what was there rather than
 * `active`: a report is filed while its content is live, but the author can delete it, or a
 * seller mark a listing sold, before an admin gets to the queue. Restoring those to `active`
 * brought back content its author had taken down.
 *
 * Read, then a write that holds only while the row is still on what was read, so the answer is
 * the status actually replaced even when the author acts in between. A row already moderated —
 * under another report — is left alone and answered as `moderated`; the decision is still
 * audited, since it is one.
 */
export const moderateTarget = async (
  table: ReportableTable,
  id: number,
  actor: string,
  reason: string
): Promise<string | null> => {
  for (let attempt = 0; attempt < MODERATE_ATTEMPTS; attempt++) {
    // `table` comes from the allowlist above, never from the payload.
    const row = await Database.single<{ status: unknown } | null>(
      `SELECT \`status\` FROM \`${table}\` WHERE \`id\` = ?`,
      [id]
    );
    if (!row) return null;
    const current = String(row.status);

    if (current === MODERATED) {
      await audit(table, id, true, actor, reason);
      return MODERATED;
    }
    if (await moveStatus(table, id, current, MODERATED)) {
      await audit(table, id, true, actor, reason);
      return current;
    }
  }
  throw new Error(`[moderation] ${table} #${id} kept changing status under a takedown`);
};

/**
 * Put moderated content back to `status`, the one its takedown replaced (MICA-386).
 *
 * Only while the row is still moderated: a row something else has moved since is not this
 * reopen's to overwrite, and answers false. `status` is checked for shape rather than trusted —
 * it is server-written, off the row itself, but it is about to be written back unscoped.
 */
export const restoreTarget = async (
  table: ReportableTable,
  id: number,
  status: string,
  actor: string,
  reason: string
): Promise<boolean> => {
  if (!isRestorableStatus(status)) {
    throw new Error(`[moderation] refusing to restore ${table} #${id} to '${status}'`);
  }
  const ok = await moveStatus(table, id, MODERATED, status);
  if (ok) await audit(table, id, false, actor, reason);
  return ok;
};
