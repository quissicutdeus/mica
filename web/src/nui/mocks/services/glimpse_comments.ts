// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GlimpseComment } from '@mica/shared/types';
import type { MockHandler } from '../registry';
import {
  mockAccounts,
  mockBlocks,
  mockGlimpseComments,
  mockGlimpsePosts,
  mockOwnedAccountIds
} from '../social';

let nextCommentId = 100;

const owned = (accountId: number) =>
  mockAccounts.find(
    (a) => a.id === accountId && a.app === 'glimpse' && mockOwnedAccountIds.has(a.id)
  );

const blockedEitherWay = (a: number, b: number) =>
  mockBlocks.some(
    (x) => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a)
  );

/**
 * Comments under a Glimpse post (MICA-253), answering `glimpseCommentsContract`'s three
 * actions. There is no generic create, get, update or delete to mock: all four are off.
 */
export const mocks: Record<string, MockHandler> = {
  'glimpse_comments:create': ({
    account_id,
    post_id,
    body
  }: {
    account_id: number;
    post_id: number;
    body: string;
  }) => {
    const account = owned(account_id);
    if (!account) throw new Error('That account is not yours to comment from.');
    const post = mockGlimpsePosts.find((p) => p.id === post_id && p.status === 'active');
    if (!post) throw new Error('That post is gone.');
    // Neither side may have blocked the other, as the server checks.
    if (blockedEitherWay(account_id, post.account_id)) {
      throw new Error('You cannot comment on that post.');
    }
    const text = body.trim();
    if (text === '') throw new Error('A comment cannot be empty.');
    const now = new Date().toISOString();
    const created: GlimpseComment = {
      id: nextCommentId++,
      post_id,
      account_id: account.id,
      body: text,
      status: 'active',
      created_at: now,
      updated_at: now,
      handle: account.handle,
      display_name: account.display_name ?? null,
      avatar: account.avatar ?? null
    };
    mockGlimpseComments.push(created);
    return created;
  },

  /** One post's comments, `id DESC`, keyset-paged. */
  'glimpse_comments:list': ({
    post_id,
    cursor,
    limit = 30
  }: {
    post_id: number;
    cursor?: number | null;
    limit?: number;
  }) => {
    const visible = mockGlimpseComments
      .filter(
        (c) => c.post_id === post_id && c.status === 'active' && (cursor == null || c.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },

  /**
   * Remove a comment as its author, or as the owner of the post it is under. Either way the
   * acting account must be the player's; a row id alone is never authorization (§2.9).
   */
  'glimpse_comments:remove': ({ account_id, id }: { account_id: number; id: number }) => {
    if (!owned(account_id)) throw new Error('That account is not yours.');
    const comment = mockGlimpseComments.find((c) => c.id === id && c.status === 'active');
    if (!comment) return false;
    const post = mockGlimpsePosts.find((p) => p.id === comment.post_id);
    if (comment.account_id !== account_id && post?.account_id !== account_id) {
      throw new Error('That comment is not yours to remove.');
    }
    comment.status = 'deleted';
    return true;
  }
};
