import { defineService } from '../lib/defineService';
import { ownedAccount } from './Accounts';
import { Blab } from '@shared/types';
import { fields, optionalString, requirePositiveInt } from '../lib/payload';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { mentionedHandles } from '@shared/richText';
import { BlabberRepository } from '../repositories/BlabberRepository';

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
   * Likes. A child table rather than a service of its own: it is Blabber's, not shared, and
   * DDL-only keeps the generic CRUD off something that only ever needs insert, delete and
   * count. Uniqueness is the point of declaring it here at all.
   */
  childTables: [
    {
      name: 'gphone_blabber_likes',
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
    }
  ],
  // Custom: has to verify the account is the caller's before accepting a post.
  options: { disableCreate: true },
  /**
   * Author hydration. Every read here returns rows the reader does not own, so the handle,
   * display name and avatar have to be joined on — see `BlabberRepository` for why the join
   * names its columns rather than selecting everything.
   */
  repositoryFactory: (resolved) => new BlabberRepository(resolved)
});

const app = blabber.app;
const repo = blabber.repo as BlabberRepository;
const channel = appEventChannel(APP);

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
const notifyMentions = async (body: string, fromHandle: string, blabId: number): Promise<void> => {
  const handles = mentionedHandles(body).filter((handle) => handle !== fromHandle);
  if (handles.length === 0) return;

  const placeholders = handles.map(() => '?').join(', ');
  const rows = await Database.query<{ citizenid: string }[]>(
    `SELECT DISTINCT \`citizenid\` FROM \`gphone_accounts\`
     WHERE \`app\` = ? AND \`status\` = 'active' AND \`handle\` IN (${placeholders})`,
    [APP, ...handles.slice(0, 20)]
  );

  const citizenids = rows.map((row) => row.citizenid);
  if (citizenids.length === 0) return;

  channel.pushMany(
    citizenids,
    'mention',
    { blab_id: blabId, handle: fromHandle },
    { notify: { type: 'info', title: `@${fromHandle} mentioned you`, message: body.slice(0, 120) } }
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

  const replyTo =
    body.reply_to === undefined || body.reply_to === null
      ? null
      : (await visibleTarget(body.reply_to, 'reply target')).id;

  const mouthOf =
    body.mouth_of === undefined || body.mouth_of === null
      ? null
      : (await visibleTarget(body.mouth_of, 'mouth target')).id;

  /**
   * The rule the DDL cannot express: something to say, or something to repeat.
   *
   * A mouth with a body is a quote; a mouth without one is a plain repeat; a Blab with neither
   * is nothing at all, and would render as an empty row nobody can explain.
   */
  if (!text && mouthOf === null) throw new Error('A Blab needs something in it.');
  if (mouthOf !== null && replyTo !== null) {
    throw new Error('A Blab can reply or mouth, not both.');
  }

  try {
    const id = await repo.create({
      citizenid,
      account_id: account.id,
      body: text || null,
      reply_to: replyTo,
      mouth_of: mouthOf
    } as Partial<Blab>);

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
    void notifyMentions(text, account.handle, id).catch((error) =>
      console.error('[blabber] Mention notification failed for', id, error)
    );

    /**
     * The echo is shaped like a hydrated row, because the client prepends it straight into the
     * feed. Anything absent here renders blank until the next fetch — which is how mouthing
     * came to attach its quoted Blab client-side from whatever happened to be in the local
     * feed, and so showed nothing at all for a Blab mouthed from a profile or a thread.
     */
    return {
      id,
      account_id: account.id,
      handle: account.handle,
      display_name: account.display_name ?? null,
      avatar: account.avatar ?? null,
      body: text || null,
      reply_to: replyTo,
      mouth_of: mouthOf,
      mouthed: mouthOf === null ? null : await repo.findPublicById(mouthOf),
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
 * Like a Blab, as one of the caller's accounts.
 *
 * Insert-only; the unique index is what makes it idempotent rather than a read-then-write with
 * a race two rapid taps would find. A duplicate is reported as success, because from the
 * player's point of view the like is exactly as applied as they wanted.
 */
app.registerEvent('like', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const account = await ownedAccount(body.account_id, citizenid, APP);
  if (!account) throw new Error('That account is not yours.');

  const target = await visibleTarget(body.blab_id, 'blab id');

  try {
    await Database.insert(
      'INSERT INTO `gphone_blabber_likes` (`blab_id`, `account_id`) VALUES (?, ?)',
      [target.id, account.id]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/duplicate/i.test(message)) throw error;
  }
  return true;
});

app.registerEvent('unlike', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const account = await ownedAccount(body.account_id, citizenid, APP);
  if (!account) throw new Error('That account is not yours.');

  const blabId = requirePositiveInt(body.blab_id, 'blab id');
  // Scoped to the caller's own account, so a row id is not authorization to remove somebody
  // else's like (§2.9).
  await Database.update(
    'DELETE FROM `gphone_blabber_likes` WHERE `blab_id` = ? AND `account_id` = ?',
    [blabId, account.id]
  );
  return true;
});

/**
 * Reply, mouth and like counts for a page of Blabs, plus what this player has already done.
 *
 * One batched read rather than three per row. A feed of thirty posts asking individually is
 * ninety round trips through NUI, and the counts are the part a reader notices missing.
 *
 * Not denormalised onto the Blab row, which was the alternative. A `like_count` column is a
 * second copy of a fact the likes table already holds, and it drifts the first time a like is
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

  const [replies, mouths, likes] = await Promise.all([
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
      `SELECT \`blab_id\`, COUNT(*) AS total FROM \`gphone_blabber_likes\`
       WHERE \`blab_id\` IN (${placeholders})
       GROUP BY \`blab_id\``,
      ids
    )
  ]);

  const myLikes = myAccountIds.length
    ? await Database.query<{ blab_id: number }[]>(
        `SELECT \`blab_id\` FROM \`gphone_blabber_likes\`
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

  const likedByMe = new Set(myLikes.map((row) => row.blab_id));
  const mouthedByMe = new Set(myMouths.map((row) => row.mouth_of));
  const byId = (rows: { parent?: number; blab_id?: number; total: number }[]) =>
    new Map(rows.map((row) => [Number(row.parent ?? row.blab_id), Number(row.total)]));

  const replyCounts = byId(replies);
  const mouthCounts = byId(mouths);
  const likeCounts = byId(likes);

  const out: Record<number, unknown> = {};
  for (const id of ids) {
    out[id] = {
      replies: replyCounts.get(id) ?? 0,
      mouths: mouthCounts.get(id) ?? 0,
      likes: likeCounts.get(id) ?? 0,
      likedByMe: likedByMe.has(id),
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
 * The page bounds every paged read here shares.
 *
 * `defineService` clamps the generic `get`; a custom action has to do it itself, and doing it in
 * one place is what keeps `profile` and `following` from disagreeing about what a page is.
 */
const pageBounds = (body: Record<string, unknown>) => ({
  limit: Math.min(
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? body.limit
      : 30,
    60
  ),
  cursor:
    body.cursor === undefined || body.cursor === null
      ? null
      : requirePositiveInt(body.cursor, 'cursor')
});

app.registerEvent('profile', async (source, cbId, data) => {
  const body = fields(data);
  const accountId = requirePositiveInt(body.account_id, 'account id');
  const repliesOnly = body.tab === 'replies';

  const { limit, cursor } = pageBounds(body);

  /**
   * Every identifier here is a literal in this file and every value is bound — the account id,
   * the cursor and the limit all arrive from a NUI payload (§2.9). `publicColumns` is what the
   * projection comes from, so `citizenid` cannot leak: on a profile it would be the single most
   * useful field for correlating an alt back to its owner.
   */
  const projection = blabber.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const parentClause = repliesOnly ? 'IS NOT NULL' : 'IS NULL';
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';

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

  const { limit, cursor } = pageBounds(body);

  const projection = blabber.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';

  const params: unknown[] = [viewer.id];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Blab[]>(
    `SELECT ${projection} FROM \`gphone_blabber\`
     WHERE \`account_id\` IN (
       SELECT \`followee_account_id\` FROM \`gphone_account_follows\`
       WHERE \`follower_account_id\` = ?
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
