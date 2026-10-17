// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GlimpsePost } from '@mica/shared/types';
import { mockMedia } from '../data';
import type { MockHandler } from '../registry';
import {
  mockAccounts,
  mockBlocks,
  mockFollows,
  mockGlimpseComments,
  mockGlimpsePosts,
  mockOwnedAccountIds,
  toMediaPreview
} from '../social';

/** Mirrors `mica_glimpse_edit_window`'s default, which `create` reports to the UI. */
const EDIT_WINDOW_SECONDS = 900;

let nextPostId = 100;

/** The caller's account in Glimpse, or undefined — `ownedAccount(account_id, citizenid, app)`. */
const owned = (accountId: number | null | undefined) =>
  accountId == null
    ? undefined
    : mockAccounts.find(
        (a) => a.id === accountId && a.app === 'glimpse' && mockOwnedAccountIds.has(a.id)
      );

/** Accounts the viewer has blocked — one direction, as Blabber's feed filters. */
const blockedBy = (accountId: number) =>
  new Set(mockBlocks.filter((b) => b.blocker === accountId).map((b) => b.blocked));

/** Keyset paging on `id DESC`: a cursor names the last row delivered, `null` is the end. */
const pageOf = (rows: GlimpsePost[], cursor: number | null | undefined, limit: number) => {
  const visible = rows
    .filter((p) => p.status === 'active' && (cursor == null || p.id < cursor))
    .sort((a, b) => b.id - a.id);
  const page = visible.slice(0, limit);
  const hasMore = visible.length > page.length;
  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
};

/**
 * Glimpse's server, in the browser (MICA-253). Every action the contract in
 * `server/services/Glimpse.ts` declares, answering its shape; `update` and `delete` are the
 * generic ownership-scoped pair, answering a bare boolean as `ServiceEndpoint` does.
 */
export const mocks: Record<string, MockHandler> = {
  'glimpse:create': ({
    account_id,
    caption,
    attachments = []
  }: {
    account_id: number;
    caption?: string;
    attachments?: { photo_id: number }[];
  }) => {
    const account = owned(account_id);
    if (!account) throw new Error('That account is not yours to post from.');
    // `resolveOwnedAttachments`: only the caller's own live photos survive, and a post with
    // none left is refused rather than published empty.
    const photos = attachments
      .map((att) =>
        mockMedia.find((m) => m.id === att.photo_id && m.kind === 'photo' && m.status === 'active')
      )
      .filter((m) => m !== undefined);
    if (photos.length === 0) throw new Error('Pick at least one photo to post.');
    const now = new Date().toISOString();
    const id = nextPostId++;
    const created: GlimpsePost = {
      id,
      account_id: account.id,
      caption: caption?.trim() || null,
      status: 'active',
      created_at: now,
      updated_at: now,
      handle: account.handle,
      display_name: account.display_name ?? null,
      avatar: account.avatar ?? null,
      attachments: photos.map((m, n) => ({ id: id * 10 + n, media: toMediaPreview(m) }))
    };
    mockGlimpsePosts.push(created);
    return { ...created, editWindow: EDIT_WINDOW_SECONDS };
  },

  /** Generic update: the caption only, on the caller's own post. */
  'glimpse:update': ({ id, caption }: { id: number; caption?: string | null }) => {
    const post = mockGlimpsePosts.find(
      (p) => p.id === id && p.status === 'active' && owned(p.account_id)
    );
    if (!post) return false;
    if (caption !== undefined) post.caption = caption?.trim() || null;
    post.updated_at = new Date().toISOString();
    return true;
  },

  /** Generic delete: a soft delete of the caller's own post. */
  'glimpse:delete': ({ id }: { id: number }) => {
    const post = mockGlimpsePosts.find((p) => p.id === id && owned(p.account_id));
    if (!post) return false;
    post.status = 'deleted';
    return true;
  },

  'glimpse:feed': ({
    account_id,
    cursor,
    limit = 30
  }: { account_id?: number | null; cursor?: number | null; limit?: number } = {}) => {
    const blocked = account_id != null ? blockedBy(account_id) : null;
    return pageOf(
      mockGlimpsePosts.filter((p) => !(blocked && blocked.has(p.account_id))),
      cursor,
      limit
    );
  },

  'glimpse:following': ({
    account_id,
    cursor,
    limit = 30
  }: {
    account_id: number;
    cursor?: number | null;
    limit?: number;
  }) => {
    if (!owned(account_id)) throw new Error('That account is not yours.');
    const followed = new Set(
      mockFollows.filter((f) => f.follower === account_id).map((f) => f.followee)
    );
    const blocked = blockedBy(account_id);
    return pageOf(
      mockGlimpsePosts.filter((p) => followed.has(p.account_id) && !blocked.has(p.account_id)),
      cursor,
      limit
    );
  },

  'glimpse:profile': ({
    account_id,
    viewer_account_id,
    cursor,
    limit = 30
  }: {
    account_id: number;
    viewer_account_id?: number | null;
    cursor?: number | null;
    limit?: number;
  }) => {
    const account =
      mockAccounts.find(
        (a) => a.id === account_id && a.app === 'glimpse' && a.status === 'active'
      ) ?? null;
    if (!account) return { account: null, rows: [], nextCursor: null };
    // One-directional, matching Blabber: a viewer who blocked this account sees it with an
    // empty grid rather than a filtered one.
    if (
      viewer_account_id != null &&
      mockBlocks.some((b) => b.blocker === viewer_account_id && b.blocked === account_id)
    ) {
      return { account, rows: [], nextCursor: null };
    }
    return {
      account,
      ...pageOf(
        mockGlimpsePosts.filter((p) => p.account_id === account_id),
        cursor,
        limit
      )
    };
  },

  'glimpse:view': ({ id }: { id: number }) =>
    mockGlimpsePosts.find((p) => p.id === id && p.status === 'active') ?? null,

  'glimpse:engagement': ({ ids = [] }: { ids?: number[] } = {}) => {
    const out: Record<number, { comments: number }> = {};
    for (const id of ids) {
      out[id] = {
        comments: mockGlimpseComments.filter((c) => c.post_id === id && c.status === 'active')
          .length
      };
    }
    return out;
  }
};
