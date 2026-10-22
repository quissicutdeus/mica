// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService, SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { reportsContract } from '@mica/shared/contracts/reports';
import {
  MAX_NOTE_LENGTH,
  REPORTABLE,
  REPORT_CATEGORIES,
  isReportCategory,
  isReportableTable,
  isRestorableStatus,
  moderateTarget,
  oneDecisionAbout,
  registerOwnerDeletionRecorder,
  restoreTarget,
  summariseTarget,
  type ReportableTable,
  type TargetSummary
} from '../lib/moderation';
import { AuditLogger } from '../lib/AuditLogger';
import { openRows, storablePlaintext } from '../lib/contentCipher';

/** `target_preview`'s plaintext bound, which the snapshot is held to. */
const MAX_PREVIEW_CHARS = 300;

/** `reporter_label`'s width. */
const REPORTER_LABEL_MAX = 32;
import { forwardReportFiled } from '../lib/DiscordWebhook';
import { isAdmin } from './Admin';
import { accountsByIds } from './Accounts';
import { messages } from './Messages';
import { darkchatMessages, retentionHours } from './DarkchatMessages';
import type { Report, ReportResolution } from '@mica/shared/types';
import { reasonOf } from '../lib/sqlErrors';

/**
 * What a reopen restores when the report holds no record of what its takedown replaced: a
 * report moderated before MICA-386, or one whose record failed to write.
 *
 * Per table, from what that table's own author can do to a row, because the status a takedown
 * replaced is unknowable here and the wrong guesses are not alike:
 *
 * - **`mica_accounts`, `mica_blabber_dms`, `mica_darkchat_messages` → `active`.** Nothing
 *   deletes any of them — no generic delete, no named one; a Dark Chat message leaves only by
 *   its window, which is a hard delete — so `active` is the only status a takedown can have
 *   replaced. Any other guess loses the row, and an account its handle for good: `app_handle`
 *   opts out of `uniqueAfterDelete`.
 * - **`mica_marketplace` → `removed`.** Nothing produces `deleted` on a listing; a seller can
 *   mark one `sold` or `removed`, and `removed`, the seller's own takedown, is the guess that
 *   puts nothing back up for sale.
 * - **Every other table → `deleted`** (`mica_blabber`, `mica_messages`, `mica_media`, and a
 *   table declared reportable later), failing closed: guessing `active` over a row its author
 *   had deleted publishes what they took down, which is MICA-386's bug. No unique key built on
 *   status refuses a move to `deleted`.
 *
 * `deleted` is the author's own delete, not "hidden everywhere". For `mica_media` it takes a
 * photo out of its owner's gallery into their Recently Deleted, while every live message, Blab
 * and listing it is attached to shows it again: those reads, and `canSeeMedia` below, drop
 * only `moderated` (MICA-339) — exactly what the owner's own delete would have left.
 */
const UNRECORDED_BY_TABLE: ReadonlyMap<string, string> = new Map([
  ['mica_accounts', 'active'],
  ['mica_blabber_dms', 'active'],
  ['mica_darkchat_messages', 'active'],
  ['mica_marketplace', 'removed']
]);

/** The fallback for a table with no entry above. */
export const UNRECORDED_DEFAULT = 'deleted';

export const unrecordedPriorStatus = (table: string): string =>
  UNRECORDED_BY_TABLE.get(table) ?? UNRECORDED_DEFAULT;

/**
 * One decision about a reported row at a time (MICA-386 review): `oneDecisionAbout` in
 * `lib/moderation.ts`, keyed by the report's target, which an owner deleting the row under a
 * takedown queues behind too (MICA-426).
 */
const oneDecisionAt = <T>(report: Report, work: () => Promise<T>): Promise<T> =>
  oneDecisionAbout(report.target_table, report.target_id, work);

/** A report row with the column the shared `Report` wire type does not carry (MICA-386). */
type ReportRow = Report & { target_prior_status?: string | null };

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
  /**
   * Keep the status this report's takedown replaced, for its reopen (MICA-386). Null records
   * "unknown" — the row was gone — rather than leaving a previous cycle's answer in place.
   */
  async recordPriorStatus(id: number, status: string | null): Promise<boolean> {
    return await Database.update(
      `UPDATE \`${this.tableName}\` SET \`target_prior_status\` = ? WHERE \`id\` = ?`,
      [status, id]
    );
  }

  /**
   * The status recorded by another report whose takedown still holds the same row.
   *
   * A second report of content already moderated finds the row `moderated`, which is not what
   * the content goes back to. It inherits what the takedown in force replaced, so whichever
   * report is reopened last restores the status from before any of them.
   */
  async priorHeldElsewhere(report: Report): Promise<string | null> {
    const status = await Database.scalar<unknown>(
      `SELECT \`target_prior_status\` FROM \`${this.tableName}\`
       WHERE \`target_table\` = ? AND \`target_id\` = ? AND \`id\` <> ?
         AND \`resolution\` = 'actioned' AND \`status\` = 'active'
         AND \`target_prior_status\` IS NOT NULL
       ORDER BY \`id\` LIMIT 1`,
      [report.target_table, report.target_id, report.id]
    );
    return typeof status === 'string' ? status : null;
  }

  /**
   * Whether another report's takedown still holds the same row.
   *
   * Asked by a reopen after its own claim has committed, so two reports reopened at once
   * cannot each see the other as still holding and both leave the content down.
   */
  async isHeldElsewhere(report: Report): Promise<boolean> {
    const count = await Database.scalar<unknown>(
      `SELECT COUNT(*) FROM \`${this.tableName}\`
       WHERE \`target_table\` = ? AND \`target_id\` = ? AND \`id\` <> ?
         AND \`resolution\` = 'actioned' AND \`status\` = 'active'`,
      [report.target_table, report.target_id, report.id]
    );
    return Number(count) > 0;
  }

  /**
   * An owner deleted the row a takedown holds (MICA-426, `recordOwnerDeletion`): every
   * standing takedown of it restores `deleted` on its reopen, not what it recorded.
   */
  async recordOwnerDeletion(table: string, targetId: number): Promise<void> {
    await Database.update(
      `UPDATE \`${this.tableName}\` SET \`target_prior_status\` = 'deleted'
       WHERE \`target_table\` = ? AND \`target_id\` = ?
         AND \`resolution\` = 'actioned' AND \`status\` = 'active'`,
      [table, targetId]
    );
  }

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
    // The reporter's own words, sealed like the snapshot beside it (MICA-431).
    note: { type: 'string', length: MAX_NOTE_LENGTH, encrypted: true },
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
    target_author: { type: 'string', citizenId: true },
    // The status the takedown replaced, which a reopen puts back rather than `active`
    // (MICA-386). Server-written, read off the reported row; null on a report moderated before
    // MICA-386, or when the row was already gone. Read only while the report is `actioned`.
    target_prior_status: { type: 'string', length: 32 },
    // What the reporter was called where they saw the content, when not their character: their
    // alias in a Dark Chat channel (MICA-254). Server-written from the reportable declaration's
    // `reporterLabel`; null for every other table.
    reporter_label: { type: 'string', length: REPORTER_LABEL_MAX }
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

registerOwnerDeletionRecorder((table, targetId) => repo.recordOwnerDeletion(table, targetId));

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
 * A photo: the caller's own, or attached to something the caller can see — a live Blab,
 * Glimpse post or listing, which anyone can, a photo on a live Spark profile (MICA-255; looser
 * than the profile's own rule below, which also wants the reporter to hold a profile, because
 * a photo's rule cannot tell which surface it was seen on), or a live message in a thread they
 * are in.
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
       OR EXISTS (SELECT 1 FROM \`mica_glimpse_attachments\` a
                  JOIN \`mica_glimpse\` g ON g.\`id\` = a.\`post_id\`
                  WHERE a.\`media_id\` = x.\`id\` AND g.\`status\` = 'active')
       OR EXISTS (SELECT 1 FROM \`mica_marketplace_attachments\` a
                  JOIN \`mica_marketplace\` l ON l.\`id\` = a.\`listing_id\`
                  WHERE a.\`media_id\` = x.\`id\` AND l.\`status\` = 'active')
       OR EXISTS (SELECT 1 FROM \`mica_spark_photos\` a
                  JOIN \`mica_spark\` p ON p.\`id\` = a.\`profile_id\`
                  WHERE a.\`media_id\` = x.\`id\` AND p.\`status\` = 'active'))
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

/**
 * A Glimpse comment: live, under a live post — what `glimpse_comments:list` reads, which shows
 * nothing under a post that is gone or taken down.
 */
const canSeeGlimpseComment: CanSee = async (id) =>
  Boolean(
    await Database.single<unknown>(
      `SELECT 1 FROM \`mica_glimpse_comments\` c
       JOIN \`mica_glimpse\` p ON p.\`id\` = c.\`post_id\` AND p.\`status\` = 'active'
       WHERE c.\`id\` = ? AND c.\`status\` = 'active' LIMIT 1`,
      [id]
    )
  );

/**
 * A Dark Chat message: a live member of its channel, inside the retention window — what
 * `darkchat_messages:list` answers. A line a server script posted (no member wrote it) is not
 * reportable: its words are the script's, and the report would name the channel's owner, whose
 * citizenid the row carries, as their author.
 */
const canSeeDarkchatMessage: CanSee = async (id, citizenid) => {
  const row = await Database.single<{ channel_id: number } | null>(
    "SELECT `channel_id` FROM `mica_darkchat_messages` WHERE `id` = ? AND `status` = 'active' " +
      'AND `author_member_id` IS NOT NULL AND `created_at` > NOW() - INTERVAL ? HOUR LIMIT 1',
    [id, retentionHours()]
  );
  return Boolean(row) && (await darkchatMessages.repo.isMember(row!.channel_id, citizenid));
};

/**
 * A Spark profile (MICA-255): live, and the reporter holds a live Spark profile of their own —
 * the deck is shown only to a player who has one, so nobody else has seen a card to report.
 */
const canSeeSparkProfile: CanSee = async (id, citizenid) =>
  Boolean(
    await Database.single<unknown>(
      `SELECT 1 FROM \`mica_spark\` s
       WHERE s.\`id\` = ? AND s.\`status\` = 'active'
         AND EXISTS (SELECT 1 FROM \`mica_spark\` r
                     WHERE r.\`citizenid\` = ? AND r.\`status\` = 'active')
       LIMIT 1`,
      [id, citizenid]
    )
  );

const VISIBILITY = new Map<string, CanSee>([
  ['mica_messages', canSeeMessage],
  ['mica_blabber_dms', canSeeDm],
  ['mica_darkchat_messages', canSeeDarkchatMessage],
  ['mica_media', canSeeMedia],
  ['mica_accounts', whileActive('mica_accounts')],
  ['mica_blabber', whileActive('mica_blabber')],
  ['mica_glimpse', whileActive('mica_glimpse')],
  ['mica_glimpse_comments', canSeeGlimpseComment],
  ['mica_marketplace', whileActive('mica_marketplace')],
  ['mica_spark', canSeeSparkProfile]
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

  // Asked only now the caller is known to see the row, so it says nothing about one they cannot.
  const label = await REPORTABLE()[table]?.reporterLabel?.(targetId, citizenid);

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
    target_author: target.citizenid,
    ...(label ? { reporter_label: label.slice(0, REPORTER_LABEL_MAX) } : {})
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

  const previous = report.resolution;
  await oneDecisionAt(report, async () => {
    /**
     * Claim before restoring, not after. The claim carries the resolution this handler read,
     * so it fails if a concurrent `reopen` or `resolve` moved the row — and only the winner
     * goes on to restore the content, where before both did.
     */
    if (!(await repo.claimResolution(id, previous, 'pending'))) {
      throw new PlayerFacingError('That report is already open.', {
        key: 'server.reports.alreadyOpen'
      });
    }

    /**
     * Restore what the takedown replaced, not `active` (MICA-386): a row its author deleted,
     * or a listing sold, before the admin acted goes back to that. Not while another report's
     * takedown of the same row still stands — undoing one decision must not undo another, and
     * the last report reopened restores the status from before all of them.
     */
    if (
      previous !== 'actioned' ||
      !isReportableTable(report.target_table) ||
      (await repo.isHeldElsewhere(report))
    ) {
      return;
    }
    // Read again under the claim: the read above may predate a reopen and a fresh takedown
    // of this same report, whose record is the one this cycle has to restore.
    const recorded = ((await repo.findById(id)) as ReportRow | null)?.target_prior_status;
    try {
      /**
       * A restore that moves nothing is a failure, said in words (MICA-426): the row is gone,
       * or something has moved it off `moderated`. Reporting the reopen as done would tell the
       * admin the content is back when it is not, so the report is put back as it was, below,
       * and the admin told why.
       */
      const restored = await restoreTarget(
        report.target_table as ReportableTable,
        report.target_id,
        isRestorableStatus(recorded) ? recorded : unrecordedPriorStatus(report.target_table),
        citizenid,
        `report #${id} reopened`
      );
      if (!restored) {
        throw new PlayerFacingError(
          'That content can no longer be put back as it was, so the report stays resolved.',
          { key: 'server.reports.notRestorable' }
        );
      }
    } catch (error) {
      // The claim already committed, so put it back rather than leave a report showing
      // open with the takedown it describes still in force — the same reasoning `Hodlr`
      // sell gives for refunding coins when the bank credit fails.
      await repo.resolve(id, previous);
      throw error;
    }
  });

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

  await oneDecisionAt(report, async () => {
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
      let replaced: string | null;
      try {
        replaced = await moderateTarget(
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

      /**
       * Kept for the reopen (MICA-386), outside the try above: the takedown has committed, so
       * failing to record it must not release the claim over content that is now down. A
       * record that fails to write leaves the reopen on `unrecordedPriorStatus`'s guess. A row
       * already moderated under another report takes that report's record.
       */
      try {
        const prior = replaced === 'moderated' ? await repo.priorHeldElsewhere(report) : replaced;
        await repo.recordPriorStatus(id, isRestorableStatus(prior) ? prior : null);
      } catch (error) {
        // The driver's last line only: an oxmysql error embeds the whole statement above it.
        const line = reasonOf(error);
        console.error(`[reports] report #${id}: the replaced status was not recorded: ${line}`);
      }
    }
  });

  return { ok: true, resolution };
});
