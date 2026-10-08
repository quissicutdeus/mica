// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { taggedTopics } from '@mica/shared/richText';
import type { Blab } from '@mica/shared/types';
import { mockMedia } from '../data';
import type { MockHandler } from '../registry';
import { mockAccounts, mockOwnedAccountIds, mockBlabs, mockFollows, mockBlocks } from '../social';

/**
 * Hashtags per Blab, seeded from the real tokenizer so this fixture cannot say a tag exists
 * that the actual server-side indexer would not have extracted from the same body. `blabber:by_tag`,
 * `blabber:search_tags` and `blabber:trending_tags` all read this rather than re-scanning bodies —
 * mirroring `mica_blabber_tags`, the child table the server writes at create time.
 */
const mockBlabTags = new Map<number, string[]>(
  mockBlabs.map((b) => [b.id, taggedTopics(b.body ?? '')])
);

const mockEars: { blab_id: number; account_id: number }[] = [{ blab_id: 1, account_id: 2 }];
let nextBlabId = 100;

export const mocks: Record<string, MockHandler> = {
  /**
   * The public feed. Keyset paging on `id DESC`, matching the server: a cursor names the last
   * row already delivered, and `nextCursor: null` means the end. `account_id` is optional and,
   * when present, filters out accounts that account has blocked — matching `feed`'s server-side
   * `NOT IN` subquery.
   */
  'blabber:feed': ({
    account_id,
    cursor,
    limit = 30
  }: { account_id?: number; cursor?: number; limit?: number } = {}) => {
    const blocked =
      account_id !== undefined
        ? new Set(mockBlocks.filter((b) => b.blocker === account_id).map((b) => b.blocked))
        : null;
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          b.reply_to == null &&
          !(blocked && blocked.has(b.account_id)) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  /**
   * The Following feed: top-level Blabs by accounts this account follows, minus accounts it has
   * blocked.
   *
   * Paged the same way as every other read here — `id DESC`, cursor is the last id delivered,
   * `nextCursor: null` is the end. A mock that answered a bare array would let the app look right
   * in `pnpm dev` while being wrong against the real server.
   */
  'blabber:following': ({
    account_id,
    cursor,
    limit = 30
  }: {
    account_id: number;
    cursor?: number;
    limit?: number;
  }) => {
    if (!mockOwnedAccountIds.has(account_id)) throw new Error('That account is not yours.');
    const followed = new Set(
      mockFollows.filter((f) => f.follower === account_id).map((f) => f.followee)
    );
    const blocked = new Set(
      mockBlocks.filter((b) => b.blocker === account_id).map((b) => b.blocked)
    );
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          b.reply_to == null &&
          followed.has(b.account_id) &&
          !blocked.has(b.account_id) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:create': ({
    account_id,
    body,
    reply_to,
    mouth_of,
    attachments
  }: Partial<Blab> & { attachments?: { photo_id: number }[] }) => {
    // Ownership, not mere existence — this is `ownedAccount` on the server, and the message was
    // already claiming it while the check only asked whether the row existed at all.
    const account = mockAccounts.find((a) => a.id === account_id && mockOwnedAccountIds.has(a.id));
    if (!account) throw new Error('That account is not yours to post from.');
    // Inherited from the parent's own `root_id`, never walked at read time — the parent is either
    // top-level (`root_id` null, so it becomes the root) or itself a reply (`root_id` already the
    // true top-level ancestor), exactly as the server computes it at create.
    const replyParent = reply_to != null ? mockBlabs.find((b) => b.id === reply_to) : undefined;
    const rootId = replyParent ? (replyParent.root_id ?? replyParent.id) : null;
    // The real server resolves a bare `photo_id` back to a full media row before it ever
    // reaches the client (`resolveOwnedAttachments` then `findAttachmentsFor`) — a mock that
    // echoed the id alone would render a blank thumbnail while the server rendered a real one.
    const resolvedAttachments = (attachments ?? [])
      .map((att, i) => {
        const photo = mockMedia.find((p) => p.id === att.photo_id);
        return photo ? { id: i, media: photo } : null;
      })
      .filter((att): att is { id: number; media: (typeof mockMedia)[number] } => att !== null);
    const created: Blab = {
      id: nextBlabId++,
      account_id: account.id,
      // Hydrated exactly as the server's echo is, avatar and quoted Blab included. The client
      // prepends this row straight into the feed and no longer grafts the mouthed target on
      // itself, so a mock that omitted `mouthed` would render an empty quote card in the browser
      // while the real server rendered a full one — the mock disagreeing with the server is the
      // failure this file exists to avoid.
      handle: account.handle,
      display_name: account.display_name,
      avatar: account.avatar ?? null,
      body: body ?? null,
      reply_to: reply_to ?? null,
      root_id: rootId,
      mouth_of: mouth_of ?? null,
      mouthed:
        mouth_of == null
          ? null
          : (mockBlabs.find((b) => b.id === mouth_of && b.status === 'active') ?? null),
      attachments: resolvedAttachments,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    mockBlabs.unshift(created);
    // Indexed at create, matching `mica_blabber_tags` — otherwise a Blab posted in the browser
    // would never surface from a tag tap or trending chip added in this same session.
    mockBlabTags.set(created.id, taggedTopics(created.body ?? ''));
    return { ...created, editWindow: 900 };
  },
  'blabber:update': ({ id, body }: { id: number; body: string }) => {
    const blab = mockBlabs.find((b) => b.id === id);
    if (blab) blab.body = body;
    return true;
  },
  'blabber:engagement': ({ ids = [] }: { ids?: number[] } = {}) => {
    const out: Record<number, unknown> = {};
    for (const id of ids) {
      out[id] = {
        replies: mockBlabs.filter((b) => b.reply_to === id && b.status === 'active').length,
        mouths: mockBlabs.filter((b) => b.mouth_of === id && b.status === 'active').length,
        ears: mockEars.filter((l) => l.blab_id === id).length,
        earedByMe: mockEars.some((l) => l.blab_id === id && l.account_id === 1),
        mouthedByMe: mockBlabs.some(
          (b) => b.mouth_of === id && b.account_id === 1 && b.status === 'active'
        )
      };
    }
    return out;
  },
  'blabber:ear': ({ blab_id }: { blab_id: number }) => {
    if (!mockEars.some((l) => l.blab_id === blab_id && l.account_id === 1)) {
      mockEars.push({ blab_id, account_id: 1 });
    }
    return true;
  },
  'blabber:unear': ({ blab_id }: { blab_id: number }) => {
    const at = mockEars.findIndex((l) => l.blab_id === blab_id && l.account_id === 1);
    if (at >= 0) mockEars.splice(at, 1);
    return true;
  },
  /**
   * The one way to open a Blab — the root of its thread, plus every reply at any depth,
   * flattened and keyset-paged. Supersedes the single-row `blabber:blab`: that mock answered
   * "what is this row," which left the app with no way to reach a reply's own top-level
   * ancestor, exactly like the real single-row read it replaced server-side.
   *
   * `anchorId` only matters on the initial open (no `cursor`) and centers the returned window on
   * that row rather than starting from the newest reply — mirroring the real server's windowed
   * query when a feed tap or notification names a specific reply to land on.
   */
  'blabber:view': ({
    id,
    cursor,
    limit = 30,
    anchorId
  }: {
    id: number;
    cursor?: number;
    limit?: number;
    anchorId?: number;
  }) => {
    const requested = mockBlabs.find((b) => b.id === id && b.status === 'active');
    if (!requested) return { root: null, replies: [], nextCursor: null };

    const rootId = requested.root_id ?? requested.id;
    const root = mockBlabs.find((b) => b.id === rootId && b.status === 'active') ?? null;
    if (!root) return { root: null, replies: [], nextCursor: null };

    const subtree = mockBlabs
      .filter((b) => b.status === 'active' && b.id !== rootId && (b.root_id ?? b.id) === rootId)
      .sort((a, b) => b.id - a.id);

    let windowed = subtree;
    if (cursor === undefined && anchorId !== undefined) {
      // Mirrors `BlabberRepository.findFlattenedPage`'s anchor branch exactly: `newer` is read
      // ascending and capped at half the page so the window centers on the anchor instead of
      // starting from the newest reply, then reversed once back to `id DESC` for the merge.
      // `older`'s cap includes the `+1` probe row `hasMore` below reads, same as the real query's
      // `LIMIT ?` with `limit - newer.length + 1`.
      //
      // Worked example, matching `subtree = [10,9,8,7,6,5,4,3,2,1]`, `anchorId = 5`, `limit = 4`:
      //   half = ceil(4/2) = 2
      //   newerAsc  = subtree>5 reversed to ASC = [6,7,8,9,10], sliced to half  -> [6,7]
      //   newerDesc = newerAsc reversed back to DESC                            -> [7,6]
      //   older     = subtree<=5, sliced to (4 - 2 + 1 = 3)                     -> [5,4,3]
      //   windowed  = [7,6,5,4,3]  -> page = windowed.slice(0,4) = [7,6,5,4], nextCursor = 4
      const half = Math.ceil(limit / 2);
      const newerAsc = subtree
        .filter((b) => b.id > anchorId)
        .slice()
        .reverse()
        .slice(0, half);
      const newerDesc = newerAsc.slice().reverse();
      const older = subtree.filter((b) => b.id <= anchorId).slice(0, limit - newerDesc.length + 1);
      windowed = [...newerDesc, ...older];
    } else if (cursor !== undefined) {
      windowed = subtree.filter((b) => b.id < cursor);
    }

    const page = windowed.slice(0, limit);
    const hasMore = windowed.length > page.length;
    return { root, replies: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:profile': ({
    account_id,
    tab,
    cursor,
    limit = 30,
    viewer_account_id
  }: {
    account_id: number;
    tab?: string;
    cursor?: number;
    limit?: number;
    viewer_account_id?: number;
  }) => {
    // One-directional, matching the server: a viewer who has blocked this account sees an
    // empty profile rather than a filtered one.
    if (
      viewer_account_id !== undefined &&
      mockBlocks.some((b) => b.blocker === viewer_account_id && b.blocked === account_id)
    ) {
      return { rows: [], nextCursor: null };
    }
    const repliesOnly = tab === 'replies';
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          b.account_id === account_id &&
          (repliesOnly ? b.reply_to != null : b.reply_to == null) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  'blabber:delete': ({ id }: { id: number }) => {
    const blab = mockBlabs.find((b) => b.id === id);
    if (blab) blab.status = 'deleted';
    return true;
  },
  /**
   * Body search. Unlike the feed and Following, replies are included — a search answers "what
   * was said," not "what was said at the top level" — so a matched reply opens through
   * `blabber:view` like everything else, landing on its flattened root screen.
   */
  'blabber:search': ({ q, cursor, limit = 30 }: { q: string; cursor?: number; limit?: number }) => {
    const needle = q.toLowerCase();
    const visible = mockBlabs
      .filter(
        (b) =>
          b.status === 'active' &&
          (b.body ?? '').toLowerCase().includes(needle) &&
          (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  /**
   * Tag-name autocomplete for the Search app's Tags segment. Not keyset-paged — a bounded
   * autocomplete list, not a feed a player scrolls to the bottom of — matching the real server.
   */
  'blabber:search_tags': ({ q }: { q: string }) => {
    const counts = new Map<string, number>();
    for (const [, tags] of mockBlabTags) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const rows = [...counts.entries()]
      .filter(([tag]) => tag.startsWith(q.toLowerCase()))
      .map(([tag, uses]) => ({ tag, uses }))
      .sort((a, b) => b.uses - a.uses)
      // Matches the real query's `LIMIT 20` — a bounded dropdown, not a full ranking.
      .slice(0, 20);
    return { rows, nextCursor: null };
  },
  /**
   * Blabs carrying one exact tag — the shared landing spot for a Tags-search result, an inline
   * `#tag` tap, and a trending-chip tap. Exact match against `mockBlabTags`, never a substring:
   * `#car` must not surface `#cars` or `#carpet`.
   */
  'blabber:by_tag': ({
    tag,
    cursor,
    limit = 30
  }: {
    tag: string;
    cursor?: number;
    limit?: number;
  }) => {
    const ids = new Set(
      [...mockBlabTags.entries()].filter(([, tags]) => tags.includes(tag)).map(([id]) => id)
    );
    const visible = mockBlabs
      .filter(
        (b) => ids.has(b.id) && b.status === 'active' && (cursor === undefined || b.id < cursor)
      )
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  },
  /**
   * A bounded snapshot, not a list a player pages through — no cursor, matching the real
   * server's un-paged top-10. Recomputed per call rather than cached, so it can never drift from
   * `mockBlabTags` the way a denormalized count could.
   *
   * Windowed to the last 48 hours, matching the real server's `WHERE b.created_at > NOW() -
   * INTERVAL 48 HOUR`. Every fixture `created_at` predates that window, so — correctly, matching
   * what a real database would answer against this same data — this returns nothing until a
   * Blab is created during the session.
   */
  'blabber:trending_tags': () => {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const counts = new Map<string, number>();
    for (const [id, tags] of mockBlabTags) {
      const blab = mockBlabs.find((b) => b.id === id && b.status === 'active');
      if (!blab || new Date(blab.created_at).getTime() <= cutoff) continue;
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, uses]) => ({ tag, uses }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 10);
  }
};
