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
import { isAdmin } from './Admin';
import type { Report, ReportResolution } from '@shared/types';

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
  scope: 'owner',
  serverAuthored: true,
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
 * The review queue.
 *
 * Gated here rather than by hiding the Administration app. Hiding the app hides the
 * button, not the capability — a NUI request is not proof of intent (AGENTS.md §2.9),
 * and `gphonecharge` already shipped once with its gate in the wrong place.
 */
app.registerEvent('queue', async (source) => {
  if (!isAdmin(source)) throw new Error('Not authorised.');

  const pending = await repo.findAll({ resolution: 'pending' } as Partial<Report>);
  // Oldest first: a queue that surfaces the newest report first starves the backlog.
  return pending.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
});

/**
 * Everything already resolved, newest first.
 *
 * A separate call rather than a flag on `queue`, because the two are read at different
 * times and the pending list is the one that has to stay small and fast.
 */
app.registerEvent('history', async (source) => {
  if (!isAdmin(source)) throw new Error('Not authorised.');

  const rows = await repo.findAllResolved();
  return rows.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
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

  if (report.resolution === 'actioned' && isReportableTable(report.target_table)) {
    await restoreTarget(
      report.target_table as ReportableTable,
      report.target_id,
      citizenid,
      `report #${id} reopened`
    );
  }

  await repo.resolve(id, 'pending');
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

  if (action === 'moderate') {
    if (!isReportableTable(report.target_table)) {
      // Only reachable if the allowlist shrank after the report was filed.
      throw new Error('That content is no longer moderatable.');
    }
    await moderateTarget(
      report.target_table as ReportableTable,
      report.target_id,
      citizenid,
      `report #${id}: ${report.category}`
    );
  }

  const resolution: ReportResolution = action === 'moderate' ? 'actioned' : 'dismissed';
  await repo.resolve(id, resolution);
  return { ok: true, resolution };
});
