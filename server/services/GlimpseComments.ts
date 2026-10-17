// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { pageBounds } from '../lib/payload';
import { AuditLogger } from '../lib/AuditLogger';
import { accountHasBlocked, accountsOwnedBy, ownedAccount } from './Accounts';
import { GLIMPSE_APP, notifyGlimpseMentions } from './Glimpse';
import { GlimpseCommentRepository } from '../repositories/GlimpseCommentRepository';
import { glimpseCommentsContract } from '@mica/shared/contracts/glimpse_comments';
import { buildDeepLink } from '@mica/shared/deepLink';
import type { GlimpseComment } from '@mica/shared/types';

/**
 * Comments under a Glimpse post (MICA-253).
 *
 * Its own service rather than a child table of `glimpse`, because a comment is reportable on
 * its own and needs its own status: a takedown, an author's delete, and a post owner's removal
 * are each a status change on one row. `app: 'glimpse'` (through `GLIMPSE_APP`) puts it behind
 * the add-on's `mica_disabled_apps` switch, and `useService` reaches it as `<appId>_*`, the
 * precedent `blabber_dms` set before it became the app-agnostic `dms` (MICA-390).
 *
 * Every generic action is off. A comment is never edited; it is removed through `remove`,
 * because the post's owner may remove one they did not write, which an ownership-scoped generic
 * delete cannot express; and create and the page read are custom for the post and block checks.
 */
export const glimpseComments = defineService<GlimpseComment, typeof glimpseCommentsContract>({
  contract: glimpseCommentsContract,
  id: 'glimpse_comments',
  app: GLIMPSE_APP,
  table: 'mica_glimpse_comments',
  reportable: { label: 'Comment', previewColumn: 'body' },
  access: { read: 'public', write: 'owner' },
  paging: { pageSize: 30, maxPageSize: 60 },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    /** The commenting identity. Set by `create` after `ownedAccount`, never by a client. */
    account_id: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      clientFilterable: true,
      references: { table: 'mica_accounts', column: 'id' }
    },
    /** The post this sits under. Fixed at create, so a comment cannot be moved to another. */
    post_id: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      clientFilterable: true,
      references: { table: 'mica_glimpse', column: 'id' }
    },
    /** 300 characters, enforced from this declaration (§2.9). */
    body: { type: 'string', length: 300, notNull: true, clientWritable: false }
  },
  /**
   * A post's thread, and one account's comments (the moderation and account-removal walk).
   * Single-column; InnoDB's appended primary key makes `post_id` the `(post_id, id)` the
   * `id DESC` page wants.
   */
  indexes: [
    { name: 'post_id', columns: ['post_id'] },
    { name: 'account_id', columns: ['account_id'] }
  ],
  options: { disableCreate: true, disableGet: true, disableUpdate: true, disableDelete: true },
  repositoryFactory: (resolved) => new GlimpseCommentRepository(resolved)
});

const app = glimpseComments.app;
const repo = glimpseComments.repo as GlimpseCommentRepository;
const channel = appEventChannel(GLIMPSE_APP);

const paging = glimpseComments.resolved.paging;
if (!paging) {
  throw new Error("defineService('glimpse_comments'): a public read must declare paging.");
}

/** The same answer for missing, gone and moderated, so a reply never says which ids exist. */
const gone = () =>
  new PlayerFacingError('That content no longer exists.', { key: 'server.reports.targetGone' });

/**
 * Comment as one of the caller's Glimpse accounts on a live post, unless either side has
 * blocked the other: a block ends contact both ways, and a comment is written into the other
 * side's thread.
 */
app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const account = await ownedAccount(data.account_id, citizenid, GLIMPSE_APP);
  if (!account) {
    throw new PlayerFacingError('That account is not yours.', { key: 'server.accounts.notYours' });
  }

  const body = data.body.trim();
  if (!body) {
    throw new PlayerFacingError('You cannot comment on that post.', {
      key: 'server.glimpse.cannotComment'
    });
  }

  // `citizenid` is selected for the push below and goes nowhere else.
  const post = await Database.single<{ id: number; account_id: number; citizenid: string } | null>(
    "SELECT `id`, `account_id`, `citizenid` FROM `mica_glimpse` WHERE `id` = ? AND `status` = 'active' LIMIT 1",
    [data.post_id]
  );
  if (!post) throw gone();

  if (
    (await accountHasBlocked(account.id, post.account_id)) ||
    (await accountHasBlocked(post.account_id, account.id))
  ) {
    throw new PlayerFacingError('You cannot comment on that post.', {
      key: 'server.glimpse.cannotComment'
    });
  }

  const id = await repo.create({
    citizenid,
    account_id: account.id,
    post_id: post.id,
    body
  } as Partial<GlimpseComment> & { citizenid: string });

  /**
   * After the write, and never allowed to fail it. The post's owner hears `comment` unless they
   * commented on their own post (as any of their accounts); whoever the body mentions hears
   * `mention`, less the post owner, who has just been told.
   */
  try {
    if (post.citizenid !== citizenid) {
      channel.push(
        post.citizenid,
        'comment',
        { post_id: post.id, comment_id: id, handle: account.handle },
        {
          notify: {
            type: 'info',
            title: `@${account.handle} commented`,
            message: body.slice(0, 120)
          },
          kind: 'comment',
          title: `@${account.handle} commented`,
          deepLink: buildDeepLink(GLIMPSE_APP, { postId: post.id })
        }
      );
    }
  } catch (error) {
    console.error('[glimpse] Comment notification failed for', id, error);
  }
  void notifyGlimpseMentions(body, account, post.id, [post.citizenid, citizenid]).catch((error) =>
    console.error('[glimpse] Mention notification failed for comment', id, error)
  );

  const echo = await repo.findPublicById(id);
  if (echo) return echo;
  const now = new Date().toISOString();
  return {
    id,
    post_id: post.id,
    account_id: account.id,
    body,
    status: 'active',
    created_at: now,
    updated_at: now,
    handle: account.handle,
    display_name: account.display_name ?? null,
    avatar: account.avatar ?? null
  };
});

// A phone in hand, server-side: a comment is published to everyone (MICA-339).
app.requirePhoneFor('create');

/**
 * One post's comments. A public read, like the post itself, less what a block between the
 * caller's Glimpse accounts and a commenter hides — in either direction.
 */
app.registerEvent('list', async (source, cbId, data, citizenid) => {
  const { limit, cursor } = pageBounds(data, paging);
  const mine = (await accountsOwnedBy(citizenid, GLIMPSE_APP)).map((a) => a.id);
  return await repo.findPage(data.post_id, { limit, cursor, viewerAccountIds: mine });
});

/**
 * Remove a comment as its author or as the post's author. `ownedAccount` proves the acting
 * account is the session's; `removeAsAuthorOrPostOwner` proves it is one of the two, in the
 * statement that writes. A stranger, a missing id and an already-removed comment all get the
 * same refusal.
 *
 * Audited like the generic delete, and awaited for the same reason (MICA-379): the row exists
 * before the client hears the removal succeeded. `role` says which right was used, because a
 * post owner's removal is a decision about somebody else's words.
 */
app.registerEvent('remove', async (source, cbId, data, citizenid) => {
  const account = await ownedAccount(data.account_id, citizenid, GLIMPSE_APP);
  if (!account) {
    throw new PlayerFacingError('That account is not yours.', { key: 'server.accounts.notYours' });
  }
  const role = await repo.removeAsAuthorOrPostOwner(data.id, account.id);
  if (!role) throw gone();

  await AuditLogger.log({
    citizenid,
    action: 'deleted',
    service: 'glimpse_comments',
    method: 'remove',
    targetId: data.id,
    targetTable: glimpseComments.resolved.table,
    details: { role, account_id: account.id }
  });
  return true;
});
