import { defineService } from '../lib/defineService';
import { ownedAccount } from './Accounts';
import { Blab } from '@shared/types';
import { fields, optionalString, requirePositiveInt } from '../lib/payload';
import { Database } from '../lib/Database';

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
    /** 280 characters, enforced server-side from this declaration (§2.9). */
    body: { type: 'string', length: 280, notNull: true },
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
    { name: 'reply_to', columns: ['reply_to'] }
  ],
  // Custom: has to verify the account is the caller's before accepting a post.
  options: { disableCreate: true }
});

const app = blabber.app;
const repo = blabber.repo;

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

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const text = optionalString(body.body)?.trim();

  if (!text) throw new Error('A Blab needs something in it.');

  /**
   * The account id arrives in the payload, and nothing about the payload proves it belongs to
   * the session that sent it (§2.9). Without this, a player could post as anyone's handle by
   * guessing an id.
   */
  const account = await ownedAccount(body.account_id, citizenid, APP);
  if (!account) throw new Error('That account is not yours to post from.');

  /**
   * A reply has to point at something that exists and is visible. Otherwise a client can
   * attach a reply to a moderated post and resurrect it in a thread view.
   */
  let replyTo: number | null = null;
  if (body.reply_to !== undefined && body.reply_to !== null) {
    const parent = await repo.findById(Number(body.reply_to));
    if (!parent || parent.status !== 'active') {
      throw new Error('That Blab is no longer available to reply to.');
    }
    replyTo = parent.id;
  }

  const id = await repo.create({
    citizenid,
    account_id: account.id,
    body: text,
    reply_to: replyTo
  } as Partial<Blab>);

  return {
    id,
    account_id: account.id,
    handle: account.handle,
    body: text,
    reply_to: replyTo,
    status: 'active',
    editWindow: editWindowSeconds()
  };
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
app.registerEvent('profile', async (source, cbId, data) => {
  const body = fields(data);
  const accountId = requirePositiveInt(body.account_id, 'account id');
  const repliesOnly = body.tab === 'replies';

  const limit = Math.min(
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? body.limit
      : 30,
    60
  );
  const cursor =
    body.cursor === undefined || body.cursor === null
      ? null
      : requirePositiveInt(body.cursor, 'cursor');

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
    rows: page,
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
});
