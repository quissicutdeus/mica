import { defineServerApp, SchemaRepository, type ResolvedAppSchema } from '../lib/defineServerApp';
import { requirePositiveInt } from '../lib/payload';
import {
  MAX_NOTE_LENGTH,
  REPORT_CATEGORIES,
  isReportCategory,
  isReportableTable,
  moderateTarget,
  summariseTarget,
  type ReportableTable
} from '../lib/moderation';
import { isAdmin } from './AdminController';
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
}

/**
 * Player reports, and the admin queue that resolves them.
 *
 * Every generic action is off. Creating a report needs validation the generic path
 * cannot do — a target table allowlist, a category allowlist, a note length cap — and
 * reading the queue is a privileged cross-owner read, which is the exact thing the
 * ownership-scoped generic `get` exists to prevent.
 */
export const reports = defineServerApp<Report>({
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
  repositoryFactory: (resolved: ResolvedAppSchema) => new ReportRepository(resolved)
});

const app = reports.app;
const repo = reports.repo as ReportRepository;

/** File a report. Anyone may; everything about it is checked. */
app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const table = data?.targetTable;
  if (!isReportableTable(table)) {
    throw new Error('That kind of content cannot be reported.');
  }

  const targetId = requirePositiveInt(data?.targetId, 'target id');
  const category = isReportCategory(data?.category) ? data.category : 'other';
  const note =
    typeof data?.note === 'string' ? data.note.trim().slice(0, MAX_NOTE_LENGTH) : undefined;

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

/** Dismiss a report, or moderate what it points at. */
app.registerEvent('resolve', async (source, cbId, data, citizenid) => {
  if (!isAdmin(source)) throw new Error('Not authorised.');

  const id = requirePositiveInt(data?.id, 'report id');
  const action = data?.action === 'moderate' ? 'moderate' : 'dismiss';

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
