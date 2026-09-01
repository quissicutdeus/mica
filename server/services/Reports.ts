// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService, SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { fields, optionalString, requirePositiveInt } from '../lib/payload';
import {
  MAX_NOTE_LENGTH,
  REPORT_CATEGORIES,
  isReportCategory,
  isReportableTable,
  moderateTarget,
  restoreTarget,
  summariseTarget,
  type ReportableTable
} from '../lib/moderation';
import { AuditLogger } from '../lib/AuditLogger';
import { isAdmin } from './Admin';
import type { Report, ReportResolution } from '@gphone/shared/types';

/**
 * Resolving is a privileged write: the row's `citizenid` is the reporter, so the
 * ownership-scoped generic `update` would refuse the admin acting on it. Exposed as a
 * named method rather than reaching for `updateUnscoped` at the call site, matching
 * `markDeletedByAdmin` — a privileged write should be a thing with a name.
 */
class ReportRepository extends SchemaRepository<Report> {
  async resolve(id: number, resolution: ReportResolution): Promise<boolean> {
    return await this.updateUnscoped(id, { resolution } as Partial<Report>);
  }

  /**
   * Move a report from one resolution to another, **only if it is still on the one the
   * caller read**. MICA-132.
   *
   * `resolve` above cannot express this: `updateUnscoped` writes the columns it is given
   * with `id` as the whole predicate, which is right for a write that has already been
   * authorized and wrong for one that is also a claim. Two admins hitting Resolve on the
   * same queue entry both read `pending`, both passed the JavaScript check, and both
   * moderated — two takedowns and two audit entries for one decision. Admin-gated, so
   * this is a ledger-integrity bug rather than an attack, but a ledger that double-counts
   * is the thing the ledger exists to prevent.
   *
   * Answering false *is* the outcome, not a failure: it means somebody else got there
   * first, and the caller must not go on to act as though it had won.
   */
  async claimResolution(
    id: number,
    expected: ReportResolution,
    next: ReportResolution
  ): Promise<boolean> {
    return await Database.update(
      `UPDATE \`${this.tableName}\` SET \`resolution\` = ? WHERE \`id\` = ? AND \`resolution\` = ?`,
      [next, id, expected]
    );
  }

  /**
   * Everything already decided.
   *
   * A cross-owner read like the queue, so it is only reachable behind the `isAdmin`
   * check in the handler. `findAll` cannot express "not pending".
   */
  async findAllResolved(): Promise<Report[]> {
    return await Database.query<Report[]>(
      `SELECT * FROM \`${this.tableName}\`
       WHERE \`status\` = 'active' AND \`resolution\` <> 'pending'`,
      []
    );
  }
}

/**
 * Player reports, and the admin queue that resolves them.
 *
 * Every generic action is off. Creating a report needs validation the generic path
 * cannot do — a target table allowlist, a category allowlist, a note length cap — and
 * reading the queue is a privileged cross-owner read, which is the exact thing the
 * ownership-scoped generic `get` exists to prevent.
 */
export const reports = defineService<Report>({
  id: 'reports',
  access: { read: 'owner', write: 'server' },
  schema: {
    // Not a foreign key, matching gphone_audit_logs: a report has to outlive the
    // content it describes, which is the entire point once that content is moderated.
    target_table: { type: 'string', length: 64, notNull: true },
    target_id: { type: 'int', notNull: true },
    category: {
      type: 'enum',
      values: REPORT_CATEGORIES,
      notNull: true,
      default: 'other'
    },
    note: { type: 'string', length: MAX_NOTE_LENGTH },
    // Separate from the implicit `status`: that is the row's lifecycle, this is how far
    // review has got. Collapsing them would make "deleted" and "dismissed" the same.
    resolution: {
      type: 'enum',
      values: ['pending', 'actioned', 'dismissed'],
      notNull: true,
      default: 'pending'
    },
    // Captured when the report is filed so the queue still says what was reported after
    // the content has gone.
    target_preview: { type: 'string', length: 300 },
    target_author: { type: 'string', length: 50 }
  },
  indexes: [
    { name: 'resolution_created', columns: ['resolution', 'created_at'] },
    { name: 'target', columns: ['target_table', 'target_id'] }
  ],
  options: {
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  },
  repositoryFactory: (resolved: ResolvedService) => new ReportRepository(resolved)
});

const app = reports.app;
const repo = reports.repo as ReportRepository;

/** File a report. Anyone may; everything about it is checked. */
app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const table = body.targetTable;
  if (!isReportableTable(table)) {
    throw new Error('That kind of content cannot be reported.');
  }

  const targetId = requirePositiveInt(body.targetId, 'target id');
  const category = isReportCategory(body.category) ? body.category : 'other';
  const note = optionalString(body.note)?.trim().slice(0, MAX_NOTE_LENGTH) || undefined;

  const target = await summariseTarget(table, targetId);
  if (!target.exists) {
    throw new Error('That content no longer exists.');
  }

  // Reporting your own content is not moderation, it is noise in the queue.
  if (target.citizenid === citizenid) {
    throw new Error('You cannot report your own content.');
  }

  const id = await repo.create({
    citizenid,
    target_table: table,
    target_id: targetId,
    category,
    note,
    resolution: 'pending',
    target_preview: target.preview,
    target_author: target.citizenid
  } as Partial<Report>);

  return { id, ok: true };
});

/**
 * Log an admin *viewing* reported content, as distinct from acting on it (MICA-70).
 *
 * `AuditLogger` recorded a moderation decision from the day it shipped, and nothing else —
 * an admin opening the queue and reading twenty players' reported messages, photos and
 * bios left no trace at all, decision or not. Accountability for a read is unrecoverable
 * after the fact if it is not written down here: unlike a write, a read leaves no row of
 * its own for a ledger to point at later.
 *
 * One entry per report actually reaching the admin's screen, not one per call: `queue`
 * and `history` each return a list, and `target_table`/`target_id` — the same pair
 * `moderateTarget`/`restoreTarget` already log against — names one piece of content per
 * report, not the list. `details.reportId` is what tells two reports of the *same*
 * content apart, since `target_table`+`target_id` alone cannot. The `preview` and
 * `note` an admin actually read are already sitting on the report row itself
 * (`target_preview`, `note`) — logging them again here would be the exact redundant copy
 * a ledger entry should not carry.
 *
 * An empty list logs nothing: nothing was actually shown, so there is nothing to be
 * accountable for having seen.
 */
const logContentViewed = async (
  citizenid: string,
  method: 'queue' | 'history',
  rows: readonly Report[]
): Promise<void> => {
  await Promise.all(
    rows.map((row) =>
      AuditLogger.log({
        citizenid,
        action: 'viewed',
        service: 'reports',
        method,
        targetId: row.target_id,
        targetTable: row.target_table,
        details: { reportId: row.id }
      })
    )
  );
};

/**
 * The review queue.
 *
 * Gated here rather than by hiding the Administration app. Hiding the app hides the
 * button, not the capability — a NUI request is not proof of intent (AGENTS.md §2.9),
 * and `gphonecharge` already shipped once with its gate in the wrong place.
 */
app.registerEvent('queue', async (source, cbId, data, citizenid) => {
  if (!isAdmin(source)) throw new Error('Not authorised.');

  const pending = await repo.findAll({ resolution: 'pending' } as Partial<Report>);
  // Oldest first: a queue that surfaces the newest report first starves the backlog.
  const sorted = pending.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  await logContentViewed(citizenid, 'queue', sorted);
  return sorted;
});

/**
 * Everything already resolved, newest first.
 *
 * A separate call rather than a flag on `queue`, because the two are read at different
 * times and the pending list is the one that has to stay small and fast.
 */
app.registerEvent('history', async (source, cbId, data, citizenid) => {
  if (!isAdmin(source)) throw new Error('Not authorised.');

  const rows = await repo.findAllResolved();
  const sorted = rows.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  await logContentViewed(citizenid, 'history', sorted);
  return sorted;
});

/**
 * Undo a resolution, putting the report back in the queue.
 *
 * Reversing a takedown restores the content too. Without that, "undo" would clear the
 * decision while leaving the consequence in place, which is worse than no undo at all.
 */
app.registerEvent('reopen', async (source, cbId, data, citizenid) => {
  if (!isAdmin(source)) throw new Error('Not authorised.');

  const id = requirePositiveInt(fields(data).id, 'report id');
  const report = await repo.findById(id);
  if (!report) throw new Error('No such report.');
  if (report.resolution === 'pending') throw new Error('That report is already open.');

  /**
   * Claim before restoring, not after. The claim carries the resolution this handler read,
   * so it fails if a concurrent `reopen` or `resolve` moved the row — and only the winner
   * goes on to restore the content, where before both did.
   */
  const previous = report.resolution;
  if (!(await repo.claimResolution(id, previous, 'pending'))) {
    throw new Error('That report is already open.');
  }

  if (previous === 'actioned' && isReportableTable(report.target_table)) {
    try {
      await restoreTarget(
        report.target_table as ReportableTable,
        report.target_id,
        citizenid,
        `report #${id} reopened`
      );
    } catch (error) {
      // The claim already committed, so put it back rather than leave a report showing
      // open with the takedown it describes still in force — the same reasoning `Hodlr`
      // sell gives for refunding coins when the bank credit fails.
      await repo.resolve(id, previous);
      throw error;
    }
  }

  return { ok: true, resolution: 'pending' };
});

/** Dismiss a report, or moderate what it points at. */
app.registerEvent('resolve', async (source, cbId, data, citizenid) => {
  if (!isAdmin(source)) throw new Error('Not authorised.');

  const id = requirePositiveInt(fields(data).id, 'report id');
  const action = fields(data).action === 'moderate' ? 'moderate' : 'dismiss';

  const report = await repo.findById(id);
  if (!report) throw new Error('No such report.');
  if (report.resolution !== 'pending') throw new Error('That report is already resolved.');

  // Checked before the claim, so a report that cannot be moderated is refused without
  // being claimed and released again. Only reachable if the allowlist shrank after the
  // report was filed.
  if (action === 'moderate' && !isReportableTable(report.target_table)) {
    throw new Error('That content is no longer moderatable.');
  }

  const resolution: ReportResolution = action === 'moderate' ? 'actioned' : 'dismissed';

  /**
   * Claim the report *first*, then act on what it points at. Reading `resolution` and
   * checking it in JavaScript decided nothing — two admins both saw `pending` and both
   * moderated (MICA-132). Exactly one caller can move the row off `pending`, and only
   * that one goes on to take the content down.
   */
  if (!(await repo.claimResolution(id, 'pending', resolution))) {
    throw new Error('That report is already resolved.');
  }

  if (action === 'moderate') {
    try {
      await moderateTarget(
        report.target_table as ReportableTable,
        report.target_id,
        citizenid,
        `report #${id}: ${report.category}`
      );
    } catch (error) {
      // The claim already committed. Release it rather than leave a report marked actioned
      // over content that is still up — mirroring `reopen` above, and `Hodlr` sell's refund.
      await repo.resolve(id, 'pending');
      throw error;
    }
  }

  return { ok: true, resolution };
});
