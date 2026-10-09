// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService, SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { reportsContract } from '@mica/shared/contracts/reports';
import {
  MAX_NOTE_LENGTH,
  REPORT_CATEGORIES,
  isReportCategory,
  isReportableTable,
  moderateTarget,
  restoreTarget,
  summariseTarget,
  type ReportableTable,
  type TargetSummary
} from '../lib/moderation';
import { AuditLogger } from '../lib/AuditLogger';
import { openRows, storablePlaintext } from '../lib/contentCipher';

/** `target_preview`'s plaintext bound, which the snapshot is held to. */
const MAX_PREVIEW_CHARS = 300;
import { forwardReportFiled } from '../lib/DiscordWebhook';
import { isAdmin } from './Admin';
import { accountsByIds } from './Accounts';
import { messages } from './Messages';
import type { Report, ReportResolution } from '@mica/shared/types';

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
   * check in the handler. `findAll` cannot express "not pending". The preview is sealed at
   * rest (MICA-165) and opens here, as `findAll` opens it for the queue.
   */
  async findAllResolved(): Promise<Report[]> {
    return openRows(
      this.tableName,
      await Database.query<Report[]>(
        `SELECT * FROM \`${this.tableName}\`
         WHERE \`status\` = 'active' AND \`resolution\` <> 'pending'`,
        []
      )
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
export const reports = defineService<Report, typeof reportsContract>({
  contract: reportsContract,
  id: 'reports',
  // Per citizen, like Admin, whose queue reads it on either device (MICA-264).
  devices: ['phone', 'tablet'],
  access: { read: 'owner', write: 'server' },
  encryptionScope: ['target_table', 'target_id'],
  schema: {
    // Not a foreign key, matching mica_audit_logs: a report has to outlive the
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
    // the content has gone. A copy of a message or a DM, so sealed like them (MICA-165), bound
    // to the reporter and the target; the column is as wide as 300 characters' sealed form.
    target_preview: { type: 'string', length: 300, encrypted: true },
    target_author: { type: 'string', citizenId: true }
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

/**
 * Whether a player can see a row: the question a report asks before it reads one (MICA-339).
 *
 * `targetTable` and `targetId` are the payload's, and `summariseTarget` reads by id alone and
 * opens a sealed body into the report. Without this, any player could walk the ids of other
 * players' messages and DMs, copy them into the staff queue, and hold them out of retention.
 *
 * **Keyed by table here, not on the `reportable` declaration**, and **closed by default**: a
 * table declared reportable with no rule below cannot be reported at all, rather than being
 * reportable by anyone. `reports.test.ts` files a report against every declared table, so a
 * table added without a rule fails there, not in a player's hands.
 *
 * Each rule is the same question that table's own reads ask. A row that is not `active` is
 * one no app shows, so it is not visible either.
 */
type CanSee = (id: number, citizenid: string) => Promise<boolean>;

/** A public table: anyone may see a row while it is up. */
const whileActive =
  (table: string): CanSee =>
  async (id) =>
    // `table` is a literal from the map below, never the payload.
    Boolean(
      await Database.single<unknown>(
        `SELECT 1 FROM \`${table}\` WHERE \`id\` = ? AND \`status\` = 'active' LIMIT 1`,
        [id]
      )
    );

/** A message: membership of its thread, through the Messages declaration's own predicate. */
const canSeeMessage: CanSee = async (id, citizenid) => {
  const row = await Database.single<{ conversation_id: number } | null>(
    "SELECT `conversation_id` FROM `mica_messages` WHERE `id` = ? AND `status` = 'active' LIMIT 1",
    [id]
  );
  return Boolean(row) && (await messages.repo.isMember(row!.conversation_id, citizenid));
};

/** A DM: one of the caller's live accounts is one of its two ends. */
const canSeeDm: CanSee = async (id, citizenid) => {
  const row = await Database.single<{ from_account: number; to_account: number } | null>(
    'SELECT `from_account`, `to_account` FROM `mica_blabber_dms` ' +
      "WHERE `id` = ? AND `status` = 'active' LIMIT 1",
    [id]
  );
  if (!row) return false;
  const ends = await accountsByIds([row.from_account, row.to_account]);
  return ends.some((end) => end.citizenid === citizenid && end.status === 'active');
};

/**
 * A photo: the caller's own, or attached to something the caller can see — a live Blab or
 * listing, which anyone can, or a live message in a thread they are in.
 *
 * The photo's own status is asked the way the attachment reads ask it: not `moderated`. Those
 * reads drop a moderated photo from every thread, Blab and listing (MICA-339), so it is not
 * visible and is answered as gone. A photo its owner only *deleted* from their gallery still
 * shows in the thread it was sent to, so it can still be reported.
 */
const canSeeMedia: CanSee = async (id, citizenid) => {
  const reachable = await Database.single<unknown>(
    `SELECT 1 FROM \`mica_media\` x WHERE x.\`id\` = ? AND x.\`status\` <> 'moderated'
       AND (x.\`citizenid\` = ?
       OR EXISTS (SELECT 1 FROM \`mica_blabber_attachments\` a
                  JOIN \`mica_blabber\` b ON b.\`id\` = a.\`blab_id\`
                  WHERE a.\`media_id\` = x.\`id\` AND b.\`status\` = 'active')
       OR EXISTS (SELECT 1 FROM \`mica_marketplace_attachments\` a
                  JOIN \`mica_marketplace\` l ON l.\`id\` = a.\`listing_id\`
                  WHERE a.\`media_id\` = x.\`id\` AND l.\`status\` = 'active'))
     LIMIT 1`,
    [id, citizenid]
  );
  if (reachable) return true;

  const threads = await Database.query<{ conversation_id: number }[]>(
    `SELECT DISTINCT m.\`conversation_id\` FROM \`mica_messages_attachments\` a
     JOIN \`mica_messages\` m ON m.\`id\` = a.\`message_id\`
     JOIN \`mica_media\` p ON p.\`id\` = a.\`photo_id\` AND p.\`status\` <> 'moderated'
     WHERE a.\`photo_id\` = ? AND m.\`status\` = 'active'`,
    [id]
  );
  for (const thread of threads ?? []) {
    if (await messages.repo.isMember(thread.conversation_id, citizenid)) return true;
  }
  return false;
};

const VISIBILITY = new Map<string, CanSee>([
  ['mica_messages', canSeeMessage],
  ['mica_blabber_dms', canSeeDm],
  ['mica_media', canSeeMedia],
  ['mica_accounts', whileActive('mica_accounts')],
  ['mica_blabber', whileActive('mica_blabber')],
  ['mica_marketplace', whileActive('mica_marketplace')]
]);

const canSeeTarget = async (table: string, id: number, citizenid: string): Promise<boolean> => {
  const rule = VISIBILITY.get(table);
  return rule ? await rule(id, citizenid) : false;
};

/** File a report. Anyone may; everything about it is checked. */
app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const table = data.targetTable;
  // The contract bounds the string; this is the allowlist, and it is a registry apps declare
  // into rather than a list `shared/` could hold.
  if (!isReportableTable(table)) {
    throw new PlayerFacingError('That kind of content cannot be reported.', {
      key: 'server.reports.notReportable'
    });
  }

  const targetId = data.targetId;
  // An unrecognised category still files under `other`: a report is worth more than the label
  // on it, and losing one to a spelling would be the wrong trade.
  const category = isReportCategory(data.category) ? data.category : 'other';
  // Trimmed, not capped — the contract already refused anything over the column's length.
  const note = data.note?.trim() || undefined;

  // Asked before the row is read, and answered as a missing row: a different reply would
  // tell the caller which ids exist in a table they cannot see into.
  const visible = await canSeeTarget(table, targetId, citizenid);
  const target: TargetSummary = visible
    ? await summariseTarget(table, targetId)
    : { exists: false };
  if (!target.exists) {
    throw new PlayerFacingError('That content no longer exists.', {
      key: 'server.reports.targetGone'
    });
  }

  // Reporting your own content is not moderation, it is noise in the queue.
  if (target.citizenid === citizenid) {
    throw new PlayerFacingError('You cannot report your own content.', {
      key: 'server.reports.ownContent'
    });
  }

  const id = await repo.create({
    citizenid,
    target_table: table,
    target_id: targetId,
    category,
    note,
    resolution: 'pending',
    // The reported player's words, which must never be what refuses the report (MICA-165): a
    // post that happens to start like a sealed value is stored so it reads as the text it is.
    target_preview:
      target.preview === undefined
        ? undefined
        : await storablePlaintext(target.preview, MAX_PREVIEW_CHARS),
    target_author: target.citizenid
  } as Partial<Report>);

  // The row is written; the staff channel hears about it now (MICA-242). The mirror is
  // synchronous and never throws, so a dead webhook cannot fail the filing.
  forwardReportFiled({ reportId: id, citizenid, targetTable: table, targetId, category, note });

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
 * and `micacharge` already shipped once with its gate in the wrong place.
 */
app.registerEvent('queue', async (source, cbId, data, citizenid) => {
  if (!isAdmin(source))
    throw new PlayerFacingError('Not authorised.', { key: 'server.reports.notAuthorised' });

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
  if (!isAdmin(source))
    throw new PlayerFacingError('Not authorised.', { key: 'server.reports.notAuthorised' });

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
  if (!isAdmin(source))
    throw new PlayerFacingError('Not authorised.', { key: 'server.reports.notAuthorised' });

  const id = data.id;
  const report = await repo.findById(id);
  if (!report)
    throw new PlayerFacingError('No such report.', { key: 'server.reports.noSuchReport' });
  if (report.resolution === 'pending')
    throw new PlayerFacingError('That report is already open.', {
      key: 'server.reports.alreadyOpen'
    });

  /**
   * Claim before restoring, not after. The claim carries the resolution this handler read,
   * so it fails if a concurrent `reopen` or `resolve` moved the row — and only the winner
   * goes on to restore the content, where before both did.
   */
  const previous = report.resolution;
  if (!(await repo.claimResolution(id, previous, 'pending'))) {
    throw new PlayerFacingError('That report is already open.', {
      key: 'server.reports.alreadyOpen'
    });
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
  if (!isAdmin(source))
    throw new PlayerFacingError('Not authorised.', { key: 'server.reports.notAuthorised' });

  const { id, action } = data;

  const report = await repo.findById(id);
  if (!report)
    throw new PlayerFacingError('No such report.', { key: 'server.reports.noSuchReport' });
  if (report.resolution !== 'pending')
    throw new PlayerFacingError('That report is already resolved.', {
      key: 'server.reports.alreadyResolved'
    });

  // Checked before the claim, so a report that cannot be moderated is refused without
  // being claimed and released again. Only reachable if the allowlist shrank after the
  // report was filed.
  if (action === 'moderate' && !isReportableTable(report.target_table)) {
    throw new PlayerFacingError('That content is no longer moderatable.', {
      key: 'server.reports.notModeratable'
    });
  }

  const resolution: ReportResolution = action === 'moderate' ? 'actioned' : 'dismissed';

  /**
   * Claim the report *first*, then act on what it points at. Reading `resolution` and
   * checking it in JavaScript decided nothing — two admins both saw `pending` and both
   * moderated (MICA-132). Exactly one caller can move the row off `pending`, and only
   * that one goes on to take the content down.
   */
  if (!(await repo.claimResolution(id, 'pending', resolution))) {
    throw new PlayerFacingError('That report is already resolved.', {
      key: 'server.reports.alreadyResolved'
    });
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
