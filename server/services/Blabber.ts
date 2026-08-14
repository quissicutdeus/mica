import { defineService } from '../lib/defineService';
import { ownedAccount, isBlocked } from './Accounts';
// Media is a declared app; reuse its derived repository rather than a second instance, so
// the attachment-ownership check runs against the same allowlist Messages already uses.
import { media } from './Media';
import { Blab } from '@shared/types';
import { fields, optionalString, pageBounds, requirePositiveInt } from '../lib/payload';
import { resolveOwnedAttachments } from '../lib/attachments';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { mentionedHandles, taggedTopics } from '@shared/richText';
import { BlabberRepository } from '../repositories/BlabberRepository';
import { buildDeepLink } from '@shared/deepLink';

/** The app id, which is also the handle namespace accounts are claimed in. */
const APP = 'blabber';

/**
 * Blabber: short public posts.
 *
 * The first table in this codebase whose rows are readable by players who do not own them, so
 * it is the first real consumer of nearly everything added for it — `read: 'public'` with
 * keyset paging, the `editWindow` predicate, `publicColumns` withholding `citizenid`, and the
 * shared accounts table.
 *
 * `citizenid` is the ownership anchor and never leaves the server. The **display** identity is
 * `account_id`, because a player may hold several accounts here and switch between them: if a
 * public read carried the citizenid, two deliberately-separate identities could be correlated
 * back to one person, which is the whole thing an alt exists to prevent.
 *
 * Ordered by `id DESC` like every paged read — see `PagingDefinition`. That is also what makes
 * an edit invisible to pagination: `id` never changes, so fixing a typo cannot move a post
 * under a reader mid-scroll.
 */
export const blabber = defineService<Blab>({
  id: APP,
  reportable: { label: 'Blab', previewColumn: 'body' },
  access: {
    read: 'public',
    write: 'owner',
    /**
     * Fifteen minutes to fix a typo, then the post freezes. Tunable per server by convar
     * below; the declaration is the default.
     */
    editWindow: 900
  },
  paging: { pageSize: 30, maxPageSize: 60 },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    /**
     * Which of the author's identities posted this. Never client-writable: the create action
     * verifies the account belongs to the caller, and letting a generic update move a post
     * between accounts would let somebody reattribute their own words to an alt after the fact.
     */
    account_id: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      clientFilterable: true,
      references: { table: 'gphone_accounts', column: 'id' }
    },
    /**
     * 280 characters, enforced server-side from this declaration (§2.9).
     *
     * Nullable, because a plain mouth has nothing of its own to say. `create` enforces the
     * real rule — a Blab needs a body *or* something to mouth — which the DDL cannot express.
     */
    body: { type: 'string', length: 280 },
    /**
     * The post this replies to, or null for a top-level Blab. Self-referencing rather than a
     * separate replies table: a reply is a Blab, and duplicating the shape would mean
     * duplicating the edit window, the moderation predicate and the paging.
     */
    reply_to: {
      type: 'int',
      // Set at create and never after: a generic update that could change it would let an
      // author re-parent their own words into somebody else's thread retroactively.
      clientWritable: false,
      clientFilterable: true,
      references: { table: 'gphone_blabber', column: 'id' }
    },
    /**
     * The Blab this one repeats — a **mouth**.
     *
     * Self-referencing rather than its own table, for the same reason a reply is: a mouth *is*
     * a Blab. It gets the feed, the paging, the edit window and the moderation predicate for
     * free, and it appears in the timeline at its own `id` — which is when it was mouthed,
     * which is what a reader expects.
     *
     * With a body it is a quote; without one it is a plain repeat. Both fall out of the same
     * column rather than needing a second concept.
     */
    mouth_of: {
      type: 'int',
      clientWritable: false,
      clientFilterable: true,
      references: { table: 'gphone_blabber', column: 'id' }
    },
    /**
     * The top-level ancestor of this Blab's reply chain, or null if this Blab is itself
     * top-level. Set once at create (below) from the parent's own `root_id` — never from a
     * walk up `reply_to`, and never mutated afterward. Same discipline as `reply_to` and
     * `mouth_of`: a self-reference fixed at creation, so "flatten this thread" and "find a
     * reply's top-level ancestor" are both a single indexed lookup rather than a recursive
     * query.
     */
    root_id: {
      type: 'int',
      clientWritable: false,
      clientFilterable: true,
      references: { table: 'gphone_blabber', column: 'id' }
    }
  },
  /**
   * Declared explicitly rather than with the per-column `index: true`, which pairs a column
   * with `citizenid` — right for an owner-scoped table and dead weight here, because a public
   * read never filters by owner. These are the two reads the app actually makes: one account's
   * posts, and one post's replies.
   *
   * Single-column on purpose. InnoDB appends the primary key to every secondary index, so
   * `KEY account_id` *is* physically `(account_id, id)` — which is exactly what a profile feed
   * ordered by `id DESC` wants, with nothing further to declare.
   */
  indexes: [
    { name: 'account_id', columns: ['account_id'] },
    { name: 'reply_to', columns: ['reply_to'] },
    { name: 'root_id', columns: ['root_id'] },
    /**
     * One mouth per account per Blab, enforced by the database.
     *
     * Safe as a unique index *because* MySQL permits many NULLs in one: every ordinary post
     * has `mouth_of NULL`, so this constrains mouths only. A find-then-insert would have a race
     * two rapid taps would find.
     */
    { name: 'account_mouth', columns: ['account_id', 'mouth_of'], unique: true }
  ],
  /**
   * Ears. Pairs with a Mouth: one speaks, one listens. A child table rather than a service of
   * its own: it is Blabber's, not shared, and DDL-only keeps the generic CRUD off something
   * that only ever needs insert, delete and count. Uniqueness is the point of declaring it here
   * at all.
   */
  childTables: [
    {
      name: 'gphone_blabber_ears',
      columns: {
        blab_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_blabber', column: 'id' }
        },
        account_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_accounts', column: 'id' }
        },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true }
      },
      indexes: [
        { name: 'blab_account', columns: ['blab_id', 'account_id'], unique: true },
        { name: 'account_id', columns: ['account_id'] }
      ]
    },
    /**
     * Hashtags. A child table for the same reason likes is one: it belongs to Blabber alone and
     * only ever needs insert and a keyword lookup, never the generic CRUD path.
     */
    {
      name: 'gphone_blabber_tags',
      columns: {
        blab_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_blabber', column: 'id' }
        },
        tag: { type: 'string', length: 32, notNull: true }
      },
      indexes: [
        { name: 'tag', columns: ['tag'] },
        { name: 'blab_id', columns: ['blab_id'] }
      ]
    },
    /**
     * Attachments. Mirrors `gphone_messages_attachments` — `media_id` rather than a bare
     * base64 blob, so an attachment can be a photo, a video or a GIF without a second shape.
     * `citizenid` is carried for the same reason it is on the Messages table: the ownership
     * check in `resolveOwnedAttachments` runs before insert, but the row still needs to say
     * whose upload this was for any later moderation pass, even though a public read never
     * projects it back out (§10).
     */
    {
      name: 'gphone_blabber_attachments',
      columns: {
        blab_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_blabber', column: 'id' }
        },
        citizenid: {
          type: 'string',
          length: 50,
          notNull: true,
          references: { table: 'players', column: 'citizenid' }
        },
        media_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_media', column: 'id' }
        }
      },
      indexes: [
        { name: 'blab_id', columns: ['blab_id'] },
        { name: 'citizenid', columns: ['citizenid'] },
        { name: 'media_id', columns: ['media_id'] }
      ]
    }
  ],
  /**
   * Both custom. `create` has to verify the account is the caller's before accepting a post.
   * `get` is replaced by the `feed` action below — the generic path has no way to filter out
   * accounts the viewer has blocked, since `ServiceEndpoint` never threads a caller identity
   * into a public read's `findAll` (§10's public-read reasoning stops at the ownership
   * predicate, which a public read does not have). A custom action already has `citizenid` in
   * hand, the same way `following` and `profile` do.
   */
  options: { disableCreate: true, disableGet: true },
  /**
   * Author hydration. Every read here returns rows the reader does not own, so the handle,
   * display name and avatar have to be joined on — see `BlabberRepository` for why the join
   * names its columns rather than selecting everything.
   */
  repositoryFactory: (resolved) => new BlabberRepository(resolved)
});

const app = blabber.app;
const repo = blabber.repo as BlabberRepository;
const mediaRepo = media.repo;
const channel = appEventChannel(APP);

/**
 * The declared page bounds, for the custom paged reads below. Non-null by construction: this is a
 * public read, and `defineService` throws for one without `paging` (§10).
 */
const paging = blabber.resolved.paging;
if (!paging) {
  throw new Error("defineService('blabber'): a public read must declare paging.");
}

const EDIT_WINDOW_CONVAR = 'gphone_blabber_edit_window';

/**
 * Reported to the client so the UI can hide the Edit button once the window has closed.
 *
 * A courtesy, not the boundary — the predicate in the `UPDATE` is what actually refuses a late
 * edit (§2.9). Sent because a button that appears and then fails is worse than one that was
 * never there.
 *
 * Note for whoever wires the UI: compare against `Date.now()`, **not** `useClock()`. That store
 * is fed by the client's `setTime`, which is in-game time of day, and comparing a row's
 * `created_at` to it is nonsense.
 */
const editWindowSeconds = (): number => {
  const raw = Number.parseInt(GetConvar(EDIT_WINDOW_CONVAR, '900'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 900;
};

/**
 * Notify every account mentioned in a Blab, once per owner.
 *
 * Handles resolve to accounts, and accounts to citizenids — several handles can belong to one
 * player, so the fan-out is deduplicated by owner rather than by handle. Being mentioned twice
 * in one post is one notification.
 *
 * Self-mentions are dropped: telling somebody they said their own name is noise.
 *
 * `pushMany` takes one `getAllPlayers()` snapshot for the whole set. Offline recipients are
 * skipped rather than queued — the row is written, so they get it from the ordinary fetch, which
 * is the rule §11.6 already states for message delivery.
 */
const notifyMentions = async (
  body: string,
  fromAccountId: number,
  fromHandle: string,
  blabId: number
): Promise<void> => {
  const handles = mentionedHandles(body).filter((handle) => handle !== fromHandle);
  if (handles.length === 0) return;

  const placeholders = handles.map(() => '?').join(', ');
  const rows = await Database.query<{ id: number; citizenid: string }[]>(
    `SELECT \`id\`, \`citizenid\` FROM \`gphone_accounts\`
     WHERE \`app\` = ? AND \`status\` = 'active' AND \`handle\` IN (${placeholders})`,
    [APP, ...handles.slice(0, 20)]
  );

  /**
   * Dropped when the mentioned account has blocked the poster — the same reasoning as the DM
   * refusal: a block is meant to end contact, and a mention is a form of contact a block-list
   * screen has no other way to prevent.
   */
  const notBlocked = await Promise.all(
    rows.map(async (row) => ((await isBlocked(row.id, fromAccountId)) ? null : row.citizenid))
  );
  const citizenids = [...new Set(notBlocked.filter((id): id is string => id !== null))];
  if (citizenids.length === 0) return;

  channel.pushMany(
    citizenids,
    'mention',
    { blab_id: blabId, handle: fromHandle },
    {
      notify: { type: 'info', title: `@${fromHandle} mentioned you`, message: body.slice(0, 120) },
      kind: 'mention',
      title: `@${fromHandle} mentioned you`,
      deepLink: buildDeepLink('blabber', { blabId })
    }
  );
};

/**
 * A Blab this caller may attach to: it exists and is visible.
 *
 * Shared by replies and mouths, because both point at another row and both have the same hole
 * if unchecked — attaching to a moderated Blab would resurrect removed content inside a thread
 * or a timeline.
 */
const visibleTarget = async (raw: unknown, what: string): Promise<Blab> => {
  const id = requirePositiveInt(raw, what);
  const target = await repo.findById(id);
  if (!target || target.status !== 'active') {
    throw new Error('That Blab is no longer available.');
  }
  return target;
};

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const text = optionalString(body.body)?.trim() ?? '';

  /**
   * The account id arrives in the payload, and nothing about the payload proves it belongs to
   * the session that sent it (§2.9). Without this, a player could post as anyone's handle by
   * guessing an id.
   */
  const account = await ownedAccount(body.account_id, citizenid, APP);
  if (!account) throw new Error('That account is not yours to post from.');

  const replyParent =
    body.reply_to === undefined || body.reply_to === null
      ? null
      : await visibleTarget(body.reply_to, 'reply target');
  const replyTo = replyParent?.id ?? null;
  // Inherited, never walked: the parent is either top-level (root_id null, so it becomes the
  // root) or itself a reply (root_id already the true top-level ancestor, so it passes through
  // unchanged). Either way this is one lookup already in hand, not a second query.
  const rootId = replyParent === null ? null : (replyParent.root_id ?? replyParent.id);

  const mouthOf =
    body.mouth_of === undefined || body.mouth_of === null
      ? null
      : (await visibleTarget(body.mouth_of, 'mouth target')).id;

  const attachments = await resolveOwnedAttachments(body.attachments, citizenid, mediaRepo);

  /**
   * The rule the DDL cannot express: something to say, something to repeat, or something to
   * show.
   *
   * A mouth with a body is a quote; a mouth without one is a plain repeat; a Blab with an
   * attachment and no text is a picture post; a Blab with none of the three is nothing at all,
   * and would render as an empty row nobody can explain.
   */
  if (!text && mouthOf === null && attachments.length === 0) {
    throw new Error('A Blab needs something in it.');
  }
  if (mouthOf !== null && replyTo !== null) {
    throw new Error('A Blab can reply or mouth, not both.');
  }

  try {
    const id = await repo.create({
      citizenid,
      account_id: account.id,
      body: text || null,
      reply_to: replyTo,
      mouth_of: mouthOf,
      root_id: rootId,
      attachments
    } as Partial<Blab> & { attachments: { photo_id: number }[] });

    /**
     * Fixed at creation, never re-extracted on edit — the 15-minute edit window (§10) is framed
     * as a typo fix, not a rewrite, and re-indexing on every edit would be work for a case this
     * app doesn't have.
     *
     * Never allowed to fail the post, same discipline as the mention notification just below:
     * the Blab is committed either way.
     */
    const tags = taggedTopics(text).slice(0, 20);
    if (tags.length > 0) {
      void Promise.all(
        tags.map((tag) =>
          Database.insert('INSERT INTO `gphone_blabber_tags` (`blab_id`, `tag`) VALUES (?, ?)', [
            id,
            tag
          ])
        )
      ).catch((error) => console.error('[blabber] Tag indexing failed for', id, error));
    }

    /**
     * Tell whoever was mentioned.
     *
     * Derived with the **same tokenizer the UI renders with** (`@shared/richText`), which is why
     * that file lives in `shared/` rather than under `web/`. Two definitions of "what counts as
     * a mention" is how you get one that highlights and never notifies.
     *
     * After the row is written, and never allowed to fail the post: the Blab is committed either
     * way, and the author should not see an error for something that already happened.
     */
    void notifyMentions(text, account.id, account.handle, id).catch((error) =>
      console.error('[blabber] Mention notification failed for', id, error)
    );

    /**
     * The echo is shaped like a hydrated row, because the client prepends it straight into the
     * feed. Anything absent here renders blank until the next fetch — which is how mouthing
     * came to attach its quoted Blab client-side from whatever happened to be in the local
     * feed, and so showed nothing at all for a Blab mouthed from a profile or a thread.
     */
    // Resolved before the return so the mouthed target's own hydration (which does its own
    // queries) runs first — this keeps the two independent regardless of statement order below.
    const mouthedEcho = mouthOf === null ? null : await repo.findPublicById(mouthOf);
    const attachmentsById = await repo.findAttachmentsFor([id]);

    return {
      id,
      account_id: account.id,
      handle: account.handle,
      display_name: account.display_name ?? null,
      avatar: account.avatar ?? null,
      body: text || null,
      reply_to: replyTo,
      mouth_of: mouthOf,
      mouthed: mouthedEcho,
      attachments: attachmentsById.get(id) ?? [],
      status: 'active',
      editWindow: editWindowSeconds()
    };
  } catch (error) {
    // The unique index refusing a second mouth of the same Blab. Translated, because the raw
    // driver text reaches a player's toast.
    const message = error instanceof Error ? error.message : '';
    if (mouthOf !== null && /duplicate/i.test(message)) {
      throw new Error('You have already mouthed that.');
    }
    throw error;
  }
});

/**
 * Ear a Blab, as one of the caller's accounts.
 *
 * Insert-only; the unique index is what makes it idempotent rather than a read-then-write with
 * a race two rapid taps would find. A duplicate is reported as success, because from the
 * player's point of view the ear is exactly as applied as they wanted.
 */
app.registerEvent('ear', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const account = await ownedAccount(body.account_id, citizenid, APP);
  if (!account) throw new Error('That account is not yours.');

  const target = await visibleTarget(body.blab_id, 'blab id');

  try {
    await Database.insert(
      'INSERT INTO `gphone_blabber_ears` (`blab_id`, `account_id`) VALUES (?, ?)',
      [target.id, account.id]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/duplicate/i.test(message)) throw error;
  }
  return true;
});

app.registerEvent('unear', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const account = await ownedAccount(body.account_id, citizenid, APP);
  if (!account) throw new Error('That account is not yours.');

  const blabId = requirePositiveInt(body.blab_id, 'blab id');
  // Scoped to the caller's own account, so a row id is not authorization to remove somebody
  // else's ear (§2.9).
  await Database.update(
    'DELETE FROM `gphone_blabber_ears` WHERE `blab_id` = ? AND `account_id` = ?',
    [blabId, account.id]
  );
  return true;
});

/**
 * Reply, mouth and ear counts for a page of Blabs, plus what this player has already done.
 *
 * One batched read rather than three per row. A feed of thirty posts asking individually is
 * ninety round trips through NUI, and the counts are the part a reader notices missing.
 *
 * Not denormalised onto the Blab row, which was the alternative. An `ear_count` column is a
 * second copy of a fact the ears table already holds, and it drifts the first time an ear is
 * removed by a path that forgets to decrement — the same defect class as the invented storage
 * figure in `72b6d10`.
 */
app.registerEvent('engagement', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const raw = Array.isArray(body.ids) ? body.ids : [];

  /**
   * Every id is validated and the list is capped before any of it reaches SQL. The ids are
   * interpolated as a placeholder list, so an unbounded array is both an injection-shaped risk
   * and a way to ask for one enormous query (§2.9).
   */
  const ids = raw
    .map((value) => {
      try {
        return requirePositiveInt(value, 'blab id');
      } catch {
        return null;
      }
    })
    .filter((id): id is number => id !== null)
    .slice(0, 60);

  if (ids.length === 0) return {};

  const mine = await Database.query<{ id: number }[]>(
    "SELECT `id` FROM `gphone_accounts` WHERE `citizenid` = ? AND `app` = ? AND `status` = 'active'",
    [citizenid, APP]
  );
  const myAccountIds = mine.map((row) => row.id);

  const placeholders = ids.map(() => '?').join(', ');

  const [replies, mouths, ears] = await Promise.all([
    Database.query<{ parent: number; total: number }[]>(
      `SELECT \`reply_to\` AS parent, COUNT(*) AS total FROM \`gphone_blabber\`
       WHERE \`reply_to\` IN (${placeholders}) AND \`status\` = 'active'
       GROUP BY \`reply_to\``,
      ids
    ),
    Database.query<{ parent: number; total: number; account_id: number }[]>(
      `SELECT \`mouth_of\` AS parent, COUNT(*) AS total FROM \`gphone_blabber\`
       WHERE \`mouth_of\` IN (${placeholders}) AND \`status\` = 'active'
       GROUP BY \`mouth_of\``,
      ids
    ),
    Database.query<{ blab_id: number; total: number }[]>(
      `SELECT \`blab_id\`, COUNT(*) AS total FROM \`gphone_blabber_ears\`
       WHERE \`blab_id\` IN (${placeholders})
       GROUP BY \`blab_id\``,
      ids
    )
  ]);

  const myEars = myAccountIds.length
    ? await Database.query<{ blab_id: number }[]>(
        `SELECT \`blab_id\` FROM \`gphone_blabber_ears\`
         WHERE \`blab_id\` IN (${placeholders})
         AND \`account_id\` IN (${myAccountIds.map(() => '?').join(', ')})`,
        [...ids, ...myAccountIds]
      )
    : [];

  const myMouths = myAccountIds.length
    ? await Database.query<{ mouth_of: number }[]>(
        `SELECT \`mouth_of\` FROM \`gphone_blabber\`
         WHERE \`mouth_of\` IN (${placeholders})
         AND \`account_id\` IN (${myAccountIds.map(() => '?').join(', ')})
         AND \`status\` = 'active'`,
        [...ids, ...myAccountIds]
      )
    : [];

  const earedByMe = new Set(myEars.map((row) => row.blab_id));
  const mouthedByMe = new Set(myMouths.map((row) => row.mouth_of));
  const byId = (rows: { parent?: number; blab_id?: number; total: number }[]) =>
    new Map(rows.map((row) => [Number(row.parent ?? row.blab_id), Number(row.total)]));

  const replyCounts = byId(replies);
  const mouthCounts = byId(mouths);
  const earCounts = byId(ears);

  const out: Record<number, unknown> = {};
  for (const id of ids) {
    out[id] = {
      replies: replyCounts.get(id) ?? 0,
      mouths: mouthCounts.get(id) ?? 0,
      ears: earCounts.get(id) ?? 0,
      earedByMe: earedByMe.has(id),
      mouthedByMe: mouthedByMe.has(id)
    };
  }
  return out;
});

/**
 * One account's public profile feed, split into Blabs and Replies.
 *
 * A custom action rather than the generic `get`, for one concrete reason: the two tabs are
 * `reply_to IS NULL` and `reply_to IS NOT NULL`, and the generic filter is equality. Null is now
 * handled (`{ reply_to: null }` emits `IS NULL`), which covers the Blabs tab — but there is no
 * equality that means "has a parent", and inventing a sentinel value for one caller would be
 * worse than fifteen lines here. A second app wanting this is when it gets generalised.
 *
 * Same keyset shape as every paged read — `id DESC`, cursor is the last id delivered, and
 * `nextCursor: null` means the end — because a client that has to page two different ways is a
 * client that will get one of them wrong.
 */
/**
 * The page bounds every paged read here shares, from the declaration above rather than from two
 * numbers retyped.
 *
 * `defineService` clamps the generic `get` inside `ServiceEndpoint`; a custom action does its own
 * paging and so has to clamp its own. This lived here as a local helper until the accounts
 * service's follower lists needed the same thing, at which point copying it a third time was the
 * wrong move — it is `pageBounds` in `lib/payload.ts` now.
 */
const pageOf = (body: Record<string, unknown>) => pageBounds(body, paging);

/**
 * The public feed — every account's top-level Blabs, newest first. Supersedes the generic
 * `get` (`options.disableGet: true` above), because the generic path has no caller identity to
 * filter blocked accounts with: `ServiceEndpoint` never threads one into a public read's
 * `findAll`, and a public read has no ownership predicate for a `repositoryFactory` override
 * to hook. `following` already needed exactly this shape for its own subquery.
 *
 * `account_id` is optional. A viewer with no claimed account yet (or none supplied) sees the
 * unfiltered feed — the same thing the generic `get` always returned — and the block filter
 * only ever narrows what an authenticated viewer sees, never what an anonymous read returns.
 */
app.registerEvent('feed', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const { limit, cursor } = pageOf(body);

  const viewer =
    body.account_id === undefined || body.account_id === null
      ? null
      : await ownedAccount(body.account_id, citizenid, APP);

  const projection = blabber.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const blockClause = viewer
    ? ' AND `account_id` NOT IN (SELECT `blocked_account_id` FROM `gphone_account_blocks` WHERE `blocker_account_id` = ?)'
    : '';

  const params: unknown[] = [];
  if (viewer) params.push(viewer.id);
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Blab[]>(
    `SELECT ${projection} FROM \`gphone_blabber\`
     WHERE \`status\` = 'active' AND \`reply_to\` IS NULL${blockClause}${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: await repo.hydrate(page),
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
});

/**
 * The one way to open a Blab. Every entry point — a feed tap, a search result, a tag tap, a
 * deep link — calls this and gets the same flattened screen: the root, then every reply at any
 * depth, `id DESC`, keyset-paged.
 *
 * Supersedes the earlier single-row `blab` action: that one answered "what is this row," which
 * left `Thread.svelte` making a second call for its direct replies and had no way to reach a
 * reply's own top-level ancestor at all.
 */
app.registerEvent('view', async (source, cbId, data) => {
  const body = fields(data);
  const id = requirePositiveInt(body.id, 'blab id');
  const { limit, cursor } = pageBounds(body, paging);

  const requested = await repo.findById(id);
  if (!requested || requested.status !== 'active') {
    return { root: null, replies: [], nextCursor: null };
  }

  const rootId = requested.root_id ?? requested.id;
  // Always through the public projection, never the raw `requested` row: `findById` is
  // `SELECT *` and carries `citizenid`, and the id-is-already-the-root case (every feed tap,
  // every top-level deep link) used to hand that row straight back over the wire.
  const root = await repo.findPublicById(rootId);
  if (!root) return { root: null, replies: [], nextCursor: null };

  /**
   * `anchorId` only means anything as an initial open (no cursor) and only when it genuinely
   * belongs to this subtree — a payload value naming an unrelated Blab is not proof it applies
   * here (§2.9). `findById` rather than a second `findFlattenedPage` call: this only needs to
   * know the row exists and shares this root, not its hydrated shape.
   */
  const rawAnchor = body.anchorId;
  let anchorId: number | null = null;
  if (cursor === null && rawAnchor !== undefined && rawAnchor !== null) {
    const candidate = requirePositiveInt(rawAnchor, 'anchor id');
    const owns = await repo.findById(candidate);
    if (owns && owns.status === 'active' && (owns.id === rootId || owns.root_id === rootId)) {
      anchorId = candidate;
    }
  }

  const page = await repo.findFlattenedPage(rootId, { limit, cursor, anchorId });

  // `findFlattenedPage` returns `{ rows, nextCursor }` — the generic paging shape every other
  // reader in this file uses. Renamed to `replies` here rather than spread, since `rows` next to
  // `root` reads as "which rows," and this reply is the one place in the app that answers "the
  // root, and everything under it" as two distinctly-named things.
  // `root` came from `findPublicById`, which already hydrates internally — a second `hydrate`
  // call here would be redundant work on an already-complete row.
  return {
    root,
    replies: page.rows,
    nextCursor: page.nextCursor
  };
});

/**
 * Body search. Unlike the feed and Following, replies are included: a search answers "what was
 * said," not "what was said at the top level" — a matched reply opens through `view` like
 * everything else, landing on its flattened root screen.
 */
app.registerEvent('search', async (source, cbId, data) => {
  const body = fields(data);
  const q = optionalString(body.q)?.slice(0, 64) ?? '';
  const { limit, cursor } = pageBounds(body, paging);

  const projection = blabber.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const like = `%${q}%`;

  const params: unknown[] = [like];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Blab[]>(
    `SELECT ${projection} FROM \`gphone_blabber\`
     WHERE \`status\` = 'active' AND \`body\` LIKE ?${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: await repo.hydrate(page), nextCursor: hasMore ? page[page.length - 1].id : null };
});

/**
 * Tag-name autocomplete for the Tags search segment.
 *
 * Not keyset-paged: a tag-name search answers a bounded autocomplete list, not a feed a player
 * scrolls to the bottom of. Twenty rows is generous for a dropdown and cheap for the index scan
 * this LIKE-prefix query runs against.
 */
app.registerEvent('search_tags', async (source, cbId, data) => {
  const body = fields(data);
  const q = optionalString(body.q)?.slice(0, 32) ?? '';

  const rows = await Database.query<{ tag: string; uses: number }[]>(
    `SELECT \`tag\`, COUNT(*) AS uses FROM \`gphone_blabber_tags\`
     WHERE \`tag\` LIKE ?
     GROUP BY \`tag\`
     ORDER BY uses DESC
     LIMIT 20`,
    [`${q}%`]
  );

  return { rows, nextCursor: null };
});

/**
 * Blabs carrying one exact tag — the shared landing spot for a Tags-search result, an inline
 * `#tag` tap, and a trending-chip tap. Exact match, never a substring: `#car` must not surface
 * `#cars` or `#carpet`.
 */
app.registerEvent('by_tag', async (source, cbId, data) => {
  const body = fields(data);
  const tag = optionalString(body.tag)?.slice(0, 32);
  if (!tag) throw new Error('A tag is required.');

  const { limit, cursor } = pageBounds(body, paging);
  const projection = blabber.resolved.publicColumns.map((column) => `b.\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND b.`id` < ?';

  const params: unknown[] = [tag.toLowerCase()];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Blab[]>(
    `SELECT ${projection} FROM \`gphone_blabber_tags\` t
     JOIN \`gphone_blabber\` b ON b.\`id\` = t.\`blab_id\`
     WHERE t.\`tag\` = ? AND b.\`status\` = 'active'${cursorClause}
     ORDER BY b.\`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: await repo.hydrate(page), nextCursor: hasMore ? page[page.length - 1].id : null };
});

/**
 * A bounded snapshot, not a list a player pages through — no cursor.
 *
 * Recomputed per request rather than cached: a windowed aggregate over an indexed range is not
 * the per-row denormalized count AGENTS.md's "Blabber is the worked example" section warns
 * against.
 */
app.registerEvent('trending_tags', async () => {
  return await Database.query<{ tag: string; uses: number }[]>(
    `SELECT t.\`tag\`, COUNT(*) AS uses
     FROM \`gphone_blabber_tags\` t
     JOIN \`gphone_blabber\` b ON b.\`id\` = t.\`blab_id\`
     WHERE b.\`status\` = 'active' AND b.\`created_at\` > NOW() - INTERVAL 48 HOUR
     GROUP BY t.\`tag\`
     ORDER BY uses DESC
     LIMIT 10`
  );
});

app.registerEvent('profile', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const accountId = requirePositiveInt(body.account_id, 'account id');
  const repliesOnly = body.tab === 'replies';

  const { limit, cursor } = pageOf(body);

  /**
   * Optional, and checked the same way `following`'s and `follows`'s viewer is: an absent or
   * unowned viewer just means an unfiltered read, since viewing a profile is not a privileged
   * act. One-directional — this filters what *the viewer* sees when they have blocked the
   * profile's account, never the reverse.
   */
  const viewer =
    body.viewer_account_id === undefined || body.viewer_account_id === null
      ? null
      : await ownedAccount(body.viewer_account_id, citizenid, APP);
  const viewerBlocksAuthor = viewer ? await isBlocked(viewer.id, accountId) : false;

  /**
   * Every identifier here is a literal in this file and every value is bound — the account id,
   * the cursor and the limit all arrive from a NUI payload (§2.9). `publicColumns` is what the
   * projection comes from, so `citizenid` cannot leak: on a profile it would be the single most
   * useful field for correlating an alt back to its owner.
   */
  const projection = blabber.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const parentClause = repliesOnly ? 'IS NOT NULL' : 'IS NULL';
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';

  // A viewer who has blocked this account sees an empty profile rather than a filtered one —
  // there is nothing left to page through once every post is excluded, and a partial timeline
  // would be a stranger fact to explain than an empty one.
  if (viewerBlocksAuthor) {
    return { rows: [], nextCursor: null };
  }

  const params: unknown[] = [accountId];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Blab[]>(
    `SELECT ${projection} FROM \`gphone_blabber\`
     WHERE \`account_id\` = ? AND \`status\` = 'active' AND \`reply_to\` ${parentClause}${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    /**
     * Through the same hydration the generic read uses, so the two feeds cannot disagree about
     * what an author looks like. Hydrated after slicing: the probe row exists only to answer
     * "is there more" and is never returned.
     */
    rows: await repo.hydrate(page),
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
});

/**
 * The feed of accounts one of the caller's accounts follows.
 *
 * A custom action rather than the generic `get`, and unavoidably so: the generic filter compares
 * a column to a value and this needs a set the database has to look up. The shape is otherwise
 * identical to every other paged read — `id DESC`, cursor is the last id delivered, `nextCursor:
 * null` means the end — because a client paging two different ways is a client that will get one
 * of them wrong.
 *
 * Scoped to **one** account rather than every account the player holds, which is the whole point
 * of holding several: a main and an alt follow different people, so switching accounts changes
 * the feed. `ownedAccount` is what makes that safe, since the id arrives in the payload (§2.9).
 *
 * `IN (subquery)` rather than a join, for two reasons. A join would emit one row per matching
 * follow row, so a duplicate follow — which the unique index prevents, but which the query should
 * not depend on — would duplicate a post; and the projection below names bare columns from
 * `publicColumns`, which stay unambiguous only while one table is in the FROM.
 *
 * Top-level only, like the public feed: a timeline with replies mixed in shows half a
 * conversation with no way to see what it was replying to.
 */
app.registerEvent('following', async (source, cbId, data, citizenid) => {
  const body = fields(data);

  const viewer = await ownedAccount(body.account_id, citizenid, APP);
  if (!viewer) throw new Error('That account is not yours.');

  const { limit, cursor } = pageOf(body);

  const projection = blabber.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';

  const params: unknown[] = [viewer.id, viewer.id];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Blab[]>(
    `SELECT ${projection} FROM \`gphone_blabber\`
     WHERE \`account_id\` IN (
       SELECT \`followee_account_id\` FROM \`gphone_account_follows\`
       WHERE \`follower_account_id\` = ?
     )
     AND \`account_id\` NOT IN (
       SELECT \`blocked_account_id\` FROM \`gphone_account_blocks\` WHERE \`blocker_account_id\` = ?
     )
     AND \`status\` = 'active' AND \`reply_to\` IS NULL${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: await repo.hydrate(page),
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
});
