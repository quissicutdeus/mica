// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import type { GlimpseComment } from '@mica/shared/types';
import { attachAuthors } from './GlimpseRepository';

/**
 * Comments under a Glimpse post (MICA-253): the public page read, and the one write that is not
 * ownership-scoped by `citizenid` — removing a comment as the owner of the post it sits under.
 */
export class GlimpseCommentRepository extends SchemaRepository<GlimpseComment> {
  private readonly publicColumns: readonly string[];

  constructor(resolved: ResolvedService) {
    super(resolved);
    this.publicColumns = resolved.publicColumns;
  }

  /**
   * One post's live comments, `id DESC`, keyset-paged, authors joined on. Nothing when the post
   * itself is not live: a moderated post's thread is as gone as the post.
   */
  async findPage(
    postId: number,
    opts: { limit: number; cursor: number | null; viewerAccountIds: readonly number[] }
  ): Promise<{ rows: GlimpseComment[]; nextCursor: number | null }> {
    const projection = this.publicColumns.map((column) => `c.\`${column}\``).join(', ');
    const cursorClause = opts.cursor === null ? '' : ' AND c.`id` < ?';
    const params: unknown[] = [postId];

    /**
     * Comments from an account any of the viewer's Glimpse accounts has blocked, or that has
     * blocked one of them, are left out: a block ends contact both ways. Every account the
     * session holds, because the contract names no viewer account — a thread is read as the
     * player, not as one identity.
     */
    const viewers = [...new Set(opts.viewerAccountIds)];
    let blockClause = '';
    if (viewers.length > 0) {
      const list = viewers.map(() => '?').join(', ');
      blockClause =
        ` AND c.\`account_id\` NOT IN (SELECT \`blocked_account_id\` FROM \`mica_account_blocks\` WHERE \`blocker_account_id\` IN (${list}) AND \`status\` = 'active')` +
        ` AND c.\`account_id\` NOT IN (SELECT \`blocker_account_id\` FROM \`mica_account_blocks\` WHERE \`blocked_account_id\` IN (${list}) AND \`status\` = 'active')`;
      params.push(...viewers, ...viewers);
    }
    if (opts.cursor !== null) params.push(opts.cursor);
    params.push(opts.limit + 1);

    const rows =
      (await Database.query<GlimpseComment[]>(
        `SELECT ${projection} FROM \`mica_glimpse_comments\` c
         JOIN \`mica_glimpse\` p ON p.\`id\` = c.\`post_id\` AND p.\`status\` = 'active'
         WHERE c.\`post_id\` = ? AND c.\`status\` = 'active'${blockClause}${cursorClause}
         ORDER BY c.\`id\` DESC
         LIMIT ?`,
        params
      )) ?? [];

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      rows: await attachAuthors(page),
      nextCursor: hasMore ? page[page.length - 1].id : null
    };
  }

  /** One comment through the public projection, author joined — `create`'s echo. */
  async findPublicById(id: number): Promise<GlimpseComment | null> {
    const projection = this.publicColumns.map((column) => `\`${column}\``).join(', ');
    const rows =
      (await Database.query<GlimpseComment[]>(
        `SELECT ${projection} FROM \`mica_glimpse_comments\` WHERE \`id\` = ? LIMIT 1`,
        [id]
      )) ?? [];
    const [row] = await attachAuthors(rows);
    return row ?? null;
  }

  /**
   * Soft-delete a live comment **as one account**, which must be its author or the author of
   * the post it sits under, and say which of the two it was — the audit row records it. The
   * caller has already proved, through `ownedAccount`, that the account is the session's; this
   * is the second half, and the reason it is a named method rather than the generic delete: the
   * post's owner is not the comment row's `citizenid`.
   *
   * Each attempt decides and writes in **one statement**, not `updateUnscoped` behind a
   * `SELECT`: a read then a write would leave a gap in which a moderator's takedown lands, and
   * the write would then turn `moderated` into `deleted` — the owner undoing a moderation
   * decision, and a later reopen restoring nothing. `status = 'active'` rides the same `WHERE`
   * as the ownership predicate, the way `access.editWindow`'s recency check rides its `UPDATE`.
   * The author's own attempt goes first, so a player removing their comment under their own
   * post is recorded as its author.
   *
   * Every identifier is a literal here and every value is bound (§2.9).
   */
  async removeAsAuthorOrPostOwner(
    commentId: number,
    accountId: number
  ): Promise<'author' | 'post_owner' | null> {
    const asAuthor = await Database.update(
      `UPDATE \`mica_glimpse_comments\` SET \`status\` = 'deleted'
       WHERE \`id\` = ? AND \`status\` = 'active' AND \`account_id\` = ?`,
      [commentId, accountId]
    );
    if (asAuthor) return 'author';

    const asPostOwner = await Database.update(
      `UPDATE \`mica_glimpse_comments\` c
       JOIN \`mica_glimpse\` p ON p.\`id\` = c.\`post_id\`
       SET c.\`status\` = 'deleted'
       WHERE c.\`id\` = ? AND c.\`status\` = 'active' AND p.\`account_id\` = ?`,
      [commentId, accountId]
    );
    return asPostOwner ? 'post_owner' : null;
  }
}
