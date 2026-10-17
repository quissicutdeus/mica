// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { resolveOwnedAttachments } from '../lib/attachments';
import { pageBounds } from '../lib/payload';
import {
  accounts,
  accountHasBlocked,
  accountsByHandle,
  accountsOwnedBy,
  ownedAccount
} from './Accounts';
// Media's own derived repository, so attachment ownership runs against the allowlist Messages
// and Blabber already use.
import { media } from './Media';
import { GlimpseRepository } from '../repositories/GlimpseRepository';
import { defineContract, responseType } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';
import { MAX_ATTACHMENTS } from '@mica/shared/attachments';
import { mentionedHandles } from '@mica/shared/richText';
import { buildDeepLink } from '@mica/shared/deepLink';
import type { Account, GlimpseCreated, GlimpseEngagement, GlimpsePost } from '@mica/shared/types';

/** The app id, which is also the handle namespace its accounts are claimed in. */
export const GLIMPSE_APP = 'glimpse';

const EDIT_WINDOW_CONVAR = 'mica_glimpse_edit_window';
const DEFAULT_EDIT_WINDOW = 900;

/**
 * How long after posting an author may still fix a caption, in seconds (MICA-253).
 *
 * Blabber's arrangement exactly, for Blabber's reason (MICA-108): one number behind both the
 * `access.editWindow` predicate on the `UPDATE` and the window `create` echoes to the UI, so the
 * Edit button cannot outlive the rule. **Read once, at resource start**, because `defineService`
 * resolves `access.editWindow` at declaration time. A non-numeric or non-positive value falls back
 * to fifteen minutes rather than making every caption editable forever.
 */
const EDIT_WINDOW_SECONDS = ((): number => {
  if (typeof GetConvar !== 'function') return DEFAULT_EDIT_WINDOW;
  const raw = Number.parseInt(GetConvar(EDIT_WINDOW_CONVAR, String(DEFAULT_EDIT_WINDOW)), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EDIT_WINDOW;
})();

/**
 * Glimpse's contract, declared here rather than in `shared/contracts/`, for Blabber's reason:
 * Glimpse is `core: false`, and core may not name an app the Store installs. The comments
 * contract is the exception that proves it — `glimpse_comments` is not the add-on's id, so it
 * sits in `shared/contracts/` the way `dms` does.
 *
 * `update` and `delete` are **not** here. Editing a caption and deleting a post ride the
 * generic ownership-scoped path, where the write allowlist and `access.editWindow` validate
 * them.
 *
 * None of these schemas is an authorization check. `ownedAccount` decides whether the acting
 * account belongs to the session and runs in every handler that takes one (§2.9).
 */
const page = {
  cursor: s.positiveInt().nullable().optional(),
  limit: s.positiveInt().optional()
};

type Page = { rows: GlimpsePost[]; nextCursor: number | null };

export const glimpseContract = defineContract({
  id: 'glimpse',
  actions: {
    create: {
      input: s.object({
        account_id: s.positiveInt(),
        /** `mica_glimpse.caption` is a varchar(500). Optional: a post can be only its photos. */
        caption: s.string({ max: 500 }).optional(),
        /**
         * At least one, because a photo post with no photo is not one. Ownership is
         * `resolveOwnedAttachments`' job, and the handler refuses the post if no owned photo
         * survives it — the `min` here only refuses the empty list before any query runs.
         */
        attachments: s.array(s.object({ photo_id: s.positiveInt() }), {
          min: 1,
          max: MAX_ATTACHMENTS
        })
      }),
      output: responseType<GlimpseCreated>()
    },

    /** The public feed. `account_id`, when present, filters out what that viewer has blocked. */
    feed: {
      input: s.object({ account_id: s.positiveInt().nullable().optional(), ...page }),
      output: responseType<Page>()
    },

    /** Posts by accounts this one follows. The account must be the caller's. */
    following: {
      input: s.object({ account_id: s.positiveInt(), ...page }),
      output: responseType<Page>()
    },

    /** One account's grid. A viewer who blocked it gets the account and no rows. */
    profile: {
      input: s.object({
        account_id: s.positiveInt(),
        viewer_account_id: s.positiveInt().nullable().optional(),
        ...page
      }),
      output: responseType<{
        account: Account | null;
        rows: GlimpsePost[];
        nextCursor: number | null;
      }>()
    },

    /** One post, or null when it is gone, moderated, or never existed — the three look alike. */
    view: { input: s.object({ id: s.positiveInt() }), output: responseType<GlimpsePost | null>() },

    /** Comment counts for a rendered window of posts. Likes come from `reactionsFor`. */
    engagement: {
      input: s.object({ ids: s.array(s.positiveInt(), { max: 200 }) }),
      output: responseType<Record<number, GlimpseEngagement>>()
    }
  }
});

/**
 * Glimpse: photo posts (MICA-253), Blabber's model with a carousel instead of a body.
 *
 * `citizenid` is the ownership anchor and never leaves the server; `account_id` is the display
 * identity, because a player may hold several Glimpse accounts and a public read carrying the
 * citizenid would tie them together. Likes are reactions (`mica_account_reactions`, ❤️ only —
 * the `reactable` rule below), so nothing here counts them.
 */
export const glimpse = defineService<GlimpsePost, typeof glimpseContract>({
  contract: glimpseContract,
  id: GLIMPSE_APP,
  app: GLIMPSE_APP,
  reportable: { label: 'Post', previewColumn: 'caption' },
  /**
   * A like is a ❤️ and nothing else (MICA-253). It comes from a Glimpse account — never one
   * claimed in another app's namespace, since `data.app` is the payload's — while the post is
   * up, and not across a block in either direction, the rule `glimpse_comments:create` holds a
   * comment to. A post is public while it is up, so its likes are too. Moved here from
   * Accounts' hand-kept lists (MICA-391); the SQL is unchanged.
   */
  reactable: {
    label: 'Post',
    emoji: ['\u2764\uFE0F'],
    canReact: async (account, targetId) => {
      if (account.app !== GLIMPSE_APP) return false;
      const post = await Database.single<{ account_id: number } | null>(
        "SELECT `account_id` FROM `mica_glimpse` WHERE `id` = ? AND `status` = 'active' LIMIT 1",
        [targetId]
      );
      if (!post) return false;
      return (
        !(await accountHasBlocked(account.id, post.account_id)) &&
        !(await accountHasBlocked(post.account_id, account.id))
      );
    },
    visibleTo: async (ids) => {
      const rows = await Database.query<{ id: number }[]>(
        `SELECT \`id\` FROM \`mica_glimpse\`
         WHERE \`id\` IN (${ids.map(() => '?').join(', ')}) AND \`status\` = 'active'`,
        ids
      );
      return (rows ?? []).map((row) => Number(row.id));
    }
  },
  access: {
    read: 'public',
    write: 'owner',
    /** `mica_glimpse_edit_window` seconds, read at resource start — see above. */
    editWindow: EDIT_WINDOW_SECONDS
  },
  paging: { pageSize: 30, maxPageSize: 60 },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    /**
     * Which of the author's identities posted this. Never client-writable: `create` verifies
     * the account is the caller's, and a generic update that moved a post between accounts
     * would let somebody reattribute it to an alt after the fact.
     */
    account_id: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      clientFilterable: true,
      references: { table: 'mica_accounts', column: 'id' }
    },
    /** 500 characters, enforced from this declaration (§2.9). The one generic-editable field. */
    caption: { type: 'string', length: 500 }
  },
  /**
   * One account's grid. Single-column, as Blabber's is: InnoDB appends the primary key, so this
   * is physically `(account_id, id)`, which a profile ordered by `id DESC` wants. A public read
   * never filters by owner, so the per-column `index: true` pairing with `citizenid` would be
   * dead weight.
   */
  indexes: [{ name: 'account_id', columns: ['account_id'] }],
  /**
   * The carousel. A copy of `mica_blabber_attachments`: `media_id` into `mica_media`, and the
   * uploader's `citizenid` for any later moderation pass, never projected back out.
   */
  childTables: [
    {
      name: 'mica_glimpse_attachments',
      columns: {
        post_id: {
          type: 'int',
          notNull: true,
          references: { table: 'mica_glimpse', column: 'id' }
        },
        citizenid: { type: 'string', citizenId: true, notNull: true },
        media_id: {
          type: 'int',
          notNull: true,
          references: { table: 'mica_media', column: 'id' }
        }
      },
      indexes: [
        { name: 'post_id', columns: ['post_id'] },
        { name: 'citizenid', columns: ['citizenid'] },
        { name: 'media_id', columns: ['media_id'] }
      ]
    }
  ],
  /**
   * Both custom. `create` verifies the account and the photos; `get` is `feed`, because the
   * generic public read has no caller identity to filter blocked accounts with.
   */
  options: { disableCreate: true, disableGet: true },
  repositoryFactory: (resolved) => new GlimpseRepository(resolved)
});

const app = glimpse.app;
const repo = glimpse.repo as GlimpseRepository;
const channel = appEventChannel(GLIMPSE_APP);

/** Non-null by construction: a public read without paging throws in `defineService` (§10). */
const paging = glimpse.resolved.paging;
if (!paging) {
  throw new Error("defineService('glimpse'): a public read must declare paging.");
}
const pageOf = (body: { cursor?: number | null; limit?: number }) => pageBounds(body, paging);

/**
 * A photo the caller owns and still has — Media's own `findById(id, citizenid)`, narrowed to
 * photos. Glimpse is a photo feed; a voice memo or a video in the carousel is not something its
 * UI draws. A row with no `kind` predates the column and is a photo.
 */
const ownedPhotos = {
  findById: async (id: number, citizenid: string) => {
    const row = await media.repo.findById(id, citizenid);
    return row && (row.kind ?? 'photo') === 'photo' ? row : null;
  }
};

/** A page of rows plus the probe row, as every keyset read here returns. */
const paged = async (rows: GlimpsePost[], limit: number): Promise<Page> => {
  const hasMore = rows.length > limit;
  const shown = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: await repo.hydrate(shown),
    nextCursor: hasMore ? shown[shown.length - 1].id : null
  };
};

/**
 * Notify every Glimpse account mentioned in a caption or a comment, once per owner — Blabber's
 * `notifyMentions`: handles resolve to accounts and accounts to citizenids, the author's own
 * handle is dropped, an account that has blocked the author is skipped, and `exclude` drops
 * owners told already by another push (a comment's post owner gets `comment`, not both).
 *
 * Never awaited by the write that occasions it; the caller logs a rejection.
 */
export const notifyGlimpseMentions = async (
  text: string,
  from: { id: number; handle: string },
  postId: number,
  exclude: readonly string[] = []
): Promise<void> => {
  const handles = mentionedHandles(text).filter((handle) => handle !== from.handle);
  if (handles.length === 0) return;

  const rows = await accountsByHandle(handles.slice(0, 20), GLIMPSE_APP);
  const notBlocked = await Promise.all(
    rows.map(async (row) => ((await accountHasBlocked(row.id, from.id)) ? null : row.citizenid))
  );
  const skip = new Set(exclude);
  const citizenids = [
    ...new Set(notBlocked.filter((id): id is string => id !== null && !skip.has(id)))
  ];
  if (citizenids.length === 0) return;

  channel.pushMany(
    citizenids,
    'mention',
    { post_id: postId, handle: from.handle },
    {
      notify: { type: 'info', title: `@${from.handle} mentioned you`, message: text.slice(0, 120) },
      kind: 'mention',
      title: `@${from.handle} mentioned you`,
      deepLink: buildDeepLink(GLIMPSE_APP, { postId })
    }
  );
};

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  // The account id is a number in a payload; nothing about it proves whose it is (§2.9).
  const account = await ownedAccount(data.account_id, citizenid, GLIMPSE_APP);
  if (!account) {
    throw new PlayerFacingError('That account is not yours.', { key: 'server.accounts.notYours' });
  }

  // Trimmed, not capped: the contract already refused anything over the column's length.
  const caption = data.caption?.trim() || null;

  /**
   * Only the caller's own live photos survive, deduplicated. A list whose every id was dropped
   * — somebody else's photo, a deleted one, a video — is refused rather than published as a
   * post with an empty carousel.
   */
  const photos = await resolveOwnedAttachments(data.attachments, citizenid, ownedPhotos);
  if (photos.length === 0) {
    throw new PlayerFacingError('Pick at least one photo to post.', {
      key: 'server.glimpse.needsPhoto'
    });
  }

  const id = await repo.createWithPhotos({ citizenid, account_id: account.id, caption }, photos);

  // After the write, and never allowed to fail it: the post is committed either way.
  if (caption) {
    void notifyGlimpseMentions(caption, account, id).catch((error) =>
      console.error('[glimpse] Mention notification failed for', id, error)
    );
  }

  const now = new Date().toISOString();
  const attachments = await repo.findAttachmentsFor([id]);
  return {
    id,
    account_id: account.id,
    caption,
    status: 'active',
    created_at: now,
    updated_at: now,
    handle: account.handle,
    display_name: account.display_name ?? null,
    avatar: account.avatar ?? null,
    attachments: attachments.get(id) ?? [],
    /**
     * The number the declaration enforces, so the UI hides Edit exactly when the server starts
     * refusing the save. A courtesy, not the boundary. Compare against `Date.now()`, not
     * `useClock()`, which is in-game time of day.
     */
    editWindow: EDIT_WINDOW_SECONDS
  };
});

// A phone in hand, server-side: a post is published to everyone (MICA-339).
app.requirePhoneFor('create');

/**
 * The public feed, newest first. `account_id` is optional — a viewer with no claimed account
 * sees the unfiltered feed — and when present must be the caller's, then filters out the
 * accounts that viewer has blocked, one direction, as Blabber's does.
 */
app.registerEvent('feed', async (source, cbId, data, citizenid) => {
  const { limit, cursor } = pageOf(data);
  const viewer =
    data.account_id === undefined || data.account_id === null
      ? null
      : await ownedAccount(data.account_id, citizenid, GLIMPSE_APP);

  const blockClause = viewer
    ? ' AND `account_id` NOT IN (SELECT `blocked_account_id` FROM `mica_account_blocks` WHERE `blocker_account_id` = ?)'
    : '';
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const params: unknown[] = [];
  if (viewer) params.push(viewer.id);
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<GlimpsePost[]>(
    `SELECT ${repo.projection()} FROM \`mica_glimpse\`
     WHERE \`status\` = 'active'${blockClause}${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );
  return await paged(rows ?? [], limit);
});

/**
 * Posts by the accounts one of the caller's accounts follows, less the ones it has blocked.
 * Scoped to one account, because a main and an alt follow different people.
 */
app.registerEvent('following', async (source, cbId, data, citizenid) => {
  const viewer = await ownedAccount(data.account_id, citizenid, GLIMPSE_APP);
  if (!viewer) {
    throw new PlayerFacingError('That account is not yours.', { key: 'server.accounts.notYours' });
  }

  const { limit, cursor } = pageOf(data);
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const params: unknown[] = [viewer.id, viewer.id];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<GlimpsePost[]>(
    `SELECT ${repo.projection()} FROM \`mica_glimpse\`
     WHERE \`account_id\` IN (
       SELECT \`followee_account_id\` FROM \`mica_account_follows\`
       WHERE \`follower_account_id\` = ?
     )
     AND \`account_id\` NOT IN (
       SELECT \`blocked_account_id\` FROM \`mica_account_blocks\` WHERE \`blocker_account_id\` = ?
     )
     AND \`status\` = 'active'${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );
  return await paged(rows ?? [], limit);
});

/**
 * One account's grid, with the account itself so a profile opened from a deep link has a
 * header. The account is read through `mica_accounts`' **public** projection — never
 * `activeAccount`, whose row carries the owner's citizenid — and must be a live Glimpse account.
 * A viewer, when named and the caller's, who has blocked it sees the header and no posts.
 */
app.registerEvent('profile', async (source, cbId, data, citizenid) => {
  const { limit, cursor } = pageOf(data);
  const accountProjection = accounts.resolved.publicColumns.map((c) => `\`${c}\``).join(', ');
  const account = await Database.single<Account | null>(
    `SELECT ${accountProjection} FROM \`mica_accounts\`
     WHERE \`id\` = ? AND \`app\` = ? AND \`status\` = 'active' LIMIT 1`,
    [data.account_id, GLIMPSE_APP]
  );
  if (!account) return { account: null, rows: [], nextCursor: null };

  const viewer =
    data.viewer_account_id === undefined || data.viewer_account_id === null
      ? null
      : await ownedAccount(data.viewer_account_id, citizenid, GLIMPSE_APP);
  if (viewer && (await accountHasBlocked(viewer.id, account.id))) {
    return { account, rows: [], nextCursor: null };
  }

  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const params: unknown[] = [account.id];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<GlimpsePost[]>(
    `SELECT ${repo.projection()} FROM \`mica_glimpse\`
     WHERE \`account_id\` = ? AND \`status\` = 'active'${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );
  return { account, ...(await paged(rows ?? [], limit)) };
});

/**
 * One post through the public projection, or null. Null too when a block stands between the
 * post's author and any of the caller's Glimpse accounts, either way — the contract names no
 * viewer account, so the post is read as the player — the same answer a missing post gets.
 */
app.registerEvent('view', async (source, cbId, data, citizenid) => {
  const found = await repo.findPublicById(data.id);
  if (!found) return null;
  const mine = (await accountsOwnedBy(citizenid, GLIMPSE_APP)).map((a) => a.id);
  if (mine.length === 0) return found;

  const list = mine.map(() => '?').join(', ');
  const blocked = await Database.single<unknown>(
    `SELECT 1 FROM \`mica_account_blocks\`
     WHERE (\`blocker_account_id\` IN (${list}) AND \`blocked_account_id\` = ?)
        OR (\`blocked_account_id\` IN (${list}) AND \`blocker_account_id\` = ?)
     LIMIT 1`,
    [...mine, found.account_id, ...mine, found.account_id]
  );
  return blocked ? null : found;
});

/**
 * Comment counts for a window of posts, one grouped read. Live comments under live posts only:
 * a moderated post's thread is not something a reader can open, so it has nothing to count.
 */
app.registerEvent('engagement', async (source, cbId, data) => {
  const ids = [...new Set(data.ids)];
  if (ids.length === 0) return {};

  const rows = await Database.query<{ post_id: number; total: number }[]>(
    `SELECT c.\`post_id\`, COUNT(*) AS total FROM \`mica_glimpse_comments\` c
     JOIN \`mica_glimpse\` p ON p.\`id\` = c.\`post_id\` AND p.\`status\` = 'active'
     WHERE c.\`post_id\` IN (${ids.map(() => '?').join(', ')}) AND c.\`status\` = 'active'
     GROUP BY c.\`post_id\``,
    ids
  );
  const counts = new Map((rows ?? []).map((row) => [Number(row.post_id), Number(row.total)]));

  const out: Record<number, GlimpseEngagement> = {};
  for (const id of ids) out[id] = { comments: counts.get(id) ?? 0 };
  return out;
});
