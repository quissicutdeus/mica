import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { Account } from '@shared/types';
import { fields, optionalString, pageBounds, requirePositiveInt } from '../lib/payload';
import { buildDeepLink } from '@shared/deepLink';

/**
 * Social identities, shared by every social app.
 *
 * One table with `app` as a column rather than one per app, because the fields do not differ.
 * Blabber, an Instagram-alike and a TikTok-alike all want exactly a handle, a display name, an
 * avatar and a bio — an account is just "an identity you post under", and none of them
 * disagree about what that means. What differs is the *content* model, which stays per app.
 *
 * The alternative — `gphone_blabber_accounts`, `gphone_instagram_accounts` — buys independence
 * nobody asked for and costs the same three things per app: list my accounts, verify this
 * account is mine before accepting a write, and keep handles unique. That is precisely the
 * duplication `isSystemApp` and `isParticipant` were.
 *
 * An app-specific *presentation* field, if one ever genuinely exists, goes in its own table
 * keyed on `account_id`. Adding one needs no change here, which is why starting shared costs
 * nothing later.
 *
 * **A player may hold several accounts per app** and switch between them, so nothing here is
 * one-per-citizenid. That is also why `citizenid` must never reach a public reader: it
 * correlates two deliberately-separate identities back to one person, which is the whole thing
 * an alt exists to prevent. It is excluded from every public projection automatically —
 * see `publicColumns`.
 */
export const accounts = defineService<Account>({
  id: 'accounts',
  /**
   * Previewed by **handle**, not bio. The handle identifies the account and cannot be
   * edited away between the report and the review; a bio can be blanked in seconds.
   */
  reportable: { label: 'Account', previewColumn: 'handle' },
  access: { read: 'public', write: 'owner' },
  // Required for a public read, and the ceiling a handle search answers within.
  paging: { pageSize: 30, maxPageSize: 60 },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    /**
     * Set by the custom create from the app that asked, never by a generic write — otherwise
     * a player could move an existing account into another app's handle namespace.
     */
    app: {
      type: 'string',
      length: 32,
      notNull: true,
      clientWritable: false,
      clientFilterable: true
    },
    /**
     * Claimed once and not renamed. `clientWritable: false` keeps it out of the generic
     * update, so the editable fields below are safe to expose there: renaming a handle would
     * silently break every mention of it, and there is nothing to un-break it with.
     */
    handle: {
      type: 'string',
      length: 32,
      notNull: true,
      clientWritable: false,
      clientFilterable: true
    },
    display_name: { type: 'string', length: 50 },
    avatar: { type: 'string', length: 255 },
    bio: { type: 'string', length: 160 }
  },
  indexes: [
    /**
     * Unique per app, not globally: `@ada` on Blabber and `@ada` on Instagram are different
     * identities and may well be different people. A real database constraint rather than a
     * find-then-insert, which has a race two players claiming at once would find.
     */
    { name: 'app_handle', columns: ['app', 'handle'], unique: true },
    // The switcher's read: my accounts in this app.
    { name: 'citizenid_app', columns: ['citizenid', 'app'] }
  ],
  /**
   * The follow graph, declared here rather than in Blabber.
   *
   * It is account-to-account, and accounts are shared, so a future Instagram-alike inherits the
   * graph instead of growing a parallel one. **No `citizenid` column**, and none is needed:
   * every `gphone_accounts` row carries an `app`, so a row can only ever link two accounts in
   * the same app — following `@bob` on Blabber cannot touch `@bob` somewhere else, because that
   * is a different account id. Ownership stays behind each account and invisible to readers,
   * exactly as it is for a Blab.
   *
   * DDL-only, like the likes table. What it needs is insert, delete and count, and the generic
   * CRUD path would only offer ways to get that wrong.
   */
  childTables: [
    {
      name: 'gphone_account_follows',
      columns: {
        follower_account_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_accounts', column: 'id' }
        },
        followee_account_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_accounts', column: 'id' }
        },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true }
      },
      indexes: [
        /**
         * One row per relation, enforced by the database rather than by find-then-insert —
         * the same constraint the likes table uses, and for the same reason: two rapid taps
         * would find the race.
         */
        {
          name: 'follower_followee',
          columns: ['follower_account_id', 'followee_account_id'],
          unique: true
        },
        // The other direction: who follows this account.
        { name: 'followee_account_id', columns: ['followee_account_id'] },
        /**
         * The following **list**, paged on this table's own `id DESC`.
         *
         * The unique index above already starts with `follower_account_id`, and InnoDB appends
         * the primary key to every secondary index — so for one follower it is physically
         * `(follower_account_id, followee_account_id, id)` and yields rows in followee order,
         * not id order. The list query would take a filesort. Bounded and small, but a range
         * scan for free is worth one key on a narrow table, and §10's argument applies: correct
         * by default beats correct if you happen to read the DDL first.
         *
         * The other direction needs no such key: `followee_account_id` is not unique, so InnoDB's
         * appended primary key makes it `(followee_account_id, id)` already.
         */
        { name: 'follower_recent', columns: ['follower_account_id', 'id'] }
      ]
    }
  ],
  // Custom: validates the handle, caps how many a player may hold, and translates a
  // duplicate-key collision into something a player can read.
  options: {
    disableCreate: true,
    /**
     * Nothing offers "delete your account", so nothing should register the endpoint.
     *
     * A registered action is reachable, full stop — a modified client can emit
     * `gphone:server:accounts:delete` directly, with or without a NUI route in front of
     * it. The route table never bounded that; it only ever bounded CEF XSS, which is
     * confined to registered NUI callbacks. So "the UI does not call it" is not a control,
     * and the only real one is not registering it.
     *
     * Deleting an account would also orphan every Blab and follow row pointing at it, and
     * the handle can never be reclaimed. If that becomes a feature it wants a named action
     * that decides what happens to the content, not the generic row delete.
     */
    disableDelete: true
  }
});

const app = accounts.app;
const repo = accounts.repo;

/**
 * The declared page bounds, for the custom paged reads below.
 *
 * Non-null by construction — `access.read` is `public` and `defineService` throws for a public
 * read without `paging` (§10) — so the guard is an invariant assertion rather than a branch that
 * can happen. Read from the declaration instead of restating 30 and 60, which is what keeps a
 * change up there from silently missing the follower lists down here.
 */
const paging = accounts.resolved.paging;
if (!paging) {
  throw new Error("defineService('accounts'): a public read must declare paging.");
}

/** 3–32 characters, lowercase, alphanumeric and underscore. No leading `@`; that is display. */
const HANDLE_PATTERN = /^[a-z0-9_]{3,32}$/;

const MAX_PER_APP_CONVAR = 'gphone_max_accounts_per_app';
const DEFAULT_MAX_PER_APP = 3;

/**
 * How many identities one player may hold in one app.
 *
 * Capped because the handle namespace is public and finite: without a limit, one player can
 * claim every good name in an afternoon. Three is enough for a main and a couple of alts.
 */
const maxPerApp = (): number => {
  const raw = Number.parseInt(GetConvar(MAX_PER_APP_CONVAR, String(DEFAULT_MAX_PER_APP)), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PER_APP;
};

/**
 * The accounts this player holds in an app, and how many they are allowed.
 *
 * Scoped to the caller server-side and deliberately **not** a filter on the public `get`:
 * making `citizenid` client-filterable would let anyone list anyone's accounts, which is the
 * de-anonymisation this table is built to avoid.
 *
 * `limit` rides along for the same reason `createBlab` echoes `editWindow`: it is a convar the
 * client cannot see, and an app that guesses it either hides a Claim button a player is entitled
 * to or offers one the server will refuse. The cap is still enforced in `create` — this only
 * decides what the UI draws.
 */
app.registerEvent('mine', async (source, cbId, data, citizenid) => {
  const appId = optionalString(fields(data).app);
  if (!appId) throw new Error('An app id is required.');

  const rows = await Database.query<Account[]>(
    `SELECT * FROM \`gphone_accounts\`
     WHERE \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'
     ORDER BY \`id\` ASC`,
    [citizenid, appId]
  );

  return { rows, limit: maxPerApp() };
});

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const appId = optionalString(body.app);
  const handle = optionalString(body.handle)?.toLowerCase();
  const displayName = optionalString(body.display_name) ?? null;

  if (!appId) throw new Error('An app id is required.');
  if (!handle || !HANDLE_PATTERN.test(handle)) {
    throw new Error('A handle is 3–32 characters, using lowercase letters, numbers and _.');
  }

  const held = await Database.scalar<number>(
    `SELECT COUNT(*) FROM \`gphone_accounts\`
     WHERE \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'`,
    [citizenid, appId]
  );
  const limit = maxPerApp();
  if ((held ?? 0) >= limit) {
    throw new Error(`You already hold ${limit} accounts here. Delete one to make room.`);
  }

  /**
   * Checked before inserting for the sake of the message, and the unique index is what
   * actually enforces it. Two players claiming the same handle in the same instant both pass
   * this check and one of them loses at the index — which is the correct outcome, and the
   * reason the constraint exists rather than this check standing alone.
   */
  const taken = await Database.single<{ id: number }>(
    'SELECT `id` FROM `gphone_accounts` WHERE `app` = ? AND `handle` = ? LIMIT 1',
    [appId, handle]
  );
  if (taken) throw new Error(`@${handle} is taken.`);

  try {
    const id = await repo.create({ citizenid, app: appId, handle, display_name: displayName });
    return { id, citizenid, app: appId, handle, display_name: displayName, status: 'active' };
  } catch (error) {
    // The index did its job in a race. Translate it, because the raw driver error reaches a
    // player's toast and reads as a crash.
    const message = error instanceof Error ? error.message : '';
    if (/duplicate/i.test(message)) throw new Error(`@${handle} is taken.`);
    throw error;
  }
});

/**
 * The follow graph.
 *
 * Every one of these verifies the *acting* account with `ownedAccount` before touching a row.
 * `follower_account_id` arrives in the payload and nothing about a payload proves it belongs to
 * the session that sent it (§2.9) — without the check, a player follows and unfollows on anyone
 * else's behalf by guessing an id.
 *
 * The same shape as `blabber:like`/`unlike`, which already got this right: insert-only with the
 * unique index making it idempotent, and a delete scoped to the caller's own account.
 */
app.registerEvent('follow', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const appId = optionalString(body.app);
  if (!appId) throw new Error('An app id is required.');

  const follower = await ownedAccount(body.follower_account_id, citizenid, appId);
  if (!follower) throw new Error('That account is not yours.');

  const followeeId = requirePositiveInt(body.followee_account_id, 'followee account id');

  /**
   * Following yourself is refused rather than stored. It would put your own posts in your
   * Following feed, which already has them nowhere else to be, and inflate both counts by one
   * for everybody.
   */
  if (followeeId === follower.id) throw new Error('You cannot follow yourself.');

  /**
   * The target must exist, be active, and be **in the same app**. Not decoration: a row linking
   * a Blabber account to an Instagram-alike one would be a following relation neither app's
   * feed could explain, and the app segment is the only thing keeping the two graphs apart.
   */
  const followee = await Database.single<{ id: number; citizenid: string; handle: string }>(
    `SELECT \`id\`, \`citizenid\`, \`handle\` FROM \`gphone_accounts\`
     WHERE \`id\` = ? AND \`app\` = ? AND \`status\` = 'active' LIMIT 1`,
    [followeeId, appId]
  );
  if (!followee) throw new Error('That account is no longer available.');

  try {
    await Database.insert(
      'INSERT INTO `gphone_account_follows` (`follower_account_id`, `followee_account_id`) VALUES (?, ?)',
      [follower.id, followee.id]
    );

    const channel = appEventChannel(appId);
    channel.push(
      followee.citizenid,
      'follow',
      { follower_account_id: follower.id, handle: follower.handle },
      {
        notify: {
          type: 'info',
          title: `@${follower.handle} followed you`,
          message: `Started following @${followee.handle}`
        },
        kind: 'follow',
        title: `@${follower.handle} followed you`,
        // `appId`, never a literal. This service is the shared identity for every social
        // app — the channel above was already keyed on it, and a hardcoded 'blabber' here
        // would have sent an Instagram-alike's follow notification into Blabber. The
        // convention a consuming app has to honor is the prop name, not its own id.
        deepLink: buildDeepLink(appId, { handle: follower.handle })
      }
    );
  } catch (error) {
    // The unique index refusing a duplicate. Reported as success: from the player's point of
    // view the follow is exactly as applied as they wanted.
    const message = error instanceof Error ? error.message : '';
    if (!/duplicate/i.test(message)) throw error;
  }
  return true;
});

app.registerEvent('unfollow', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const appId = optionalString(body.app);
  if (!appId) throw new Error('An app id is required.');

  const follower = await ownedAccount(body.follower_account_id, citizenid, appId);
  if (!follower) throw new Error('That account is not yours.');

  const followeeId = requirePositiveInt(body.followee_account_id, 'followee account id');

  // Scoped to the caller's own account, so a row id is not authorization to remove somebody
  // else's follow (§2.9).
  await Database.update(
    'DELETE FROM `gphone_account_follows` WHERE `follower_account_id` = ? AND `followee_account_id` = ?',
    [follower.id, followeeId]
  );
  return true;
});

/**
 * Follower and following counts for one account, plus whether the viewer follows it.
 *
 * Counted rather than denormalised onto `gphone_accounts`. A `follower_count` column is a second
 * copy of a fact the graph already holds, and it drifts the first time a follow is removed by a
 * path that forgets to decrement — the same reasoning that keeps Blabber's like counts out of
 * the Blab row.
 *
 * `viewer_account_id` is optional and checked when present. It decides the state of a Follow
 * button, and the button acts as one specific account of the caller's — so unlike `engagement`,
 * which answers across every account a player holds, this has to be about exactly one. An
 * unowned or absent viewer answers `false` rather than erroring: reading a profile is not a
 * privileged act, and only the *button* needs an identity.
 */
app.registerEvent('follows', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const appId = optionalString(body.app);
  if (!appId) throw new Error('An app id is required.');

  const accountId = requirePositiveInt(body.account_id, 'account id');

  const viewer =
    body.viewer_account_id === undefined || body.viewer_account_id === null
      ? null
      : await ownedAccount(body.viewer_account_id, citizenid, appId);

  const [followers, following, mine] = await Promise.all([
    Database.scalar<number>(
      'SELECT COUNT(*) FROM `gphone_account_follows` WHERE `followee_account_id` = ?',
      [accountId]
    ),
    Database.scalar<number>(
      'SELECT COUNT(*) FROM `gphone_account_follows` WHERE `follower_account_id` = ?',
      [accountId]
    ),
    viewer
      ? Database.single<{ id: number }>(
          `SELECT \`id\` FROM \`gphone_account_follows\`
           WHERE \`follower_account_id\` = ? AND \`followee_account_id\` = ? LIMIT 1`,
          [viewer.id, accountId]
        )
      : Promise.resolve(null)
  ]);

  return {
    followers: followers ?? 0,
    following: following ?? 0,
    followedByMe: mine !== null
  };
});

/**
 * Who follows this account, and who it follows.
 *
 * The counts above have been real since the graph shipped and were deliberately not tappable,
 * because these two screens did not exist: a count is a fact and a link to nothing is a promise.
 * These are that link.
 *
 * **Public, like the counts.** Reading who follows an account is not a privileged act — every row
 * returned is a public projection of `gphone_accounts`, so `citizenid` is withheld exactly as it is
 * on a Blab. There is no `ownedAccount` check and there must not be one: requiring ownership would
 * mean you could only see your own followers, which is not what the number on a stranger's profile
 * is counting.
 *
 * **Keyset paged on the follow row's own id, not the account's.** Three things follow from that.
 * It orders the list most-recently-followed first, which is the only ordering a reader can make
 * sense of — account id order is "whoever signed up first", and `created_at` is second-resolution,
 * so a naive cursor on it silently drops a row wherever two follows share a second (§10). It is a
 * single column that never changes. And each direction has an index that makes it a plain range
 * scan; see the declaration above.
 *
 * **A join here, where the Following *feed* deliberately used `IN (subquery)`.** Not an
 * inconsistency: there the follows table was a filter over posts, and a duplicate follow row would
 * have duplicated a post, so it belonged in a subquery. Here the follows table **is** the list —
 * one row per relation, enforced by the unique index — so it belongs in the FROM, and the account
 * is what is joined on. That is also why the projection is qualified: two tables in the FROM makes
 * a bare `id` ambiguous.
 */
const followList = async (
  data: unknown,
  direction: 'followers' | 'following'
): Promise<{ rows: Account[]; nextCursor: number | null }> => {
  const body = fields(data);
  const appId = optionalString(body.app);
  if (!appId) throw new Error('An app id is required.');

  const accountId = requirePositiveInt(body.account_id, 'account id');
  const { limit, cursor } = pageBounds(body, paging);

  /**
   * Which end of the relation is the subject and which is the row being listed. Both are literals
   * chosen by this function from a two-value union — never a payload field, which is the whole
   * reason the two actions below pass a constant instead of forwarding `data.direction`.
   */
  const subjectColumn = direction === 'followers' ? 'followee_account_id' : 'follower_account_id';
  const listedColumn = direction === 'followers' ? 'follower_account_id' : 'followee_account_id';

  /**
   * From `publicColumns`, qualified onto the accounts alias. `citizenid` is not in that list and
   * cannot be added to it by a payload — on a follower list it would correlate every alt in the
   * graph back to its owner, which is precisely what the projection rule exists to prevent (§10).
   */
  const projection = accounts.resolved.publicColumns.map((column) => `a.\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND f.`id` < ?';

  /**
   * The app is bound as well as the subject. A graph row can only ever link two accounts in one
   * app — `follow` enforces that on the way in — so this is belt and braces rather than the only
   * guard, and it costs nothing on a query already filtering the accounts table.
   */
  const params: unknown[] = [accountId, appId];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<(Account & { cursor_id: number })[]>(
    `SELECT ${projection}, f.\`id\` AS \`cursor_id\`
     FROM \`gphone_account_follows\` f
     JOIN \`gphone_accounts\` a ON a.\`id\` = f.\`${listedColumn}\`
     WHERE f.\`${subjectColumn}\` = ? AND a.\`app\` = ? AND a.\`status\` = 'active'${cursorClause}
     ORDER BY f.\`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    /**
     * The cursor rides back on the envelope, not on the rows. It is a position in this result
     * set rather than anything about the account, and a client that received it per row would
     * have two plausible things to page from.
     */
    rows: page.map(({ cursor_id, ...account }) => account as Account),
    nextCursor: hasMore ? page[page.length - 1].cursor_id : null
  };
};

app.registerEvent('followers', (source, cbId, data) => followList(data, 'followers'));
app.registerEvent('following', (source, cbId, data) => followList(data, 'following'));

/**
 * Find an account by handle or display name, within one app.
 *
 * Placed here rather than on Blabber: identity is shared (`gphone_accounts`), and a future
 * social app gets the same search for free — the same reasoning `followers`/`following` are
 * declared here rather than per-app.
 *
 * Public, like every other account read: `citizenid` is withheld by `publicColumns`
 * automatically, so this cannot answer "which accounts belong to one player" — it answers "find
 * the account named X," the same fact a handle button anywhere in the app already exposes.
 */
app.registerEvent('search', async (source, cbId, data) => {
  const body = fields(data);
  const appId = optionalString(body.app);
  if (!appId) throw new Error('An app id is required.');

  const q = optionalString(body.q)?.slice(0, 64) ?? '';
  const { limit, cursor } = pageBounds(body, paging);

  const projection = accounts.resolved.publicColumns.map((column) => `\`${column}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const like = `%${q}%`;

  const params: unknown[] = [appId, like, like];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<Account[]>(
    `SELECT ${projection} FROM \`gphone_accounts\`
     WHERE \`app\` = ? AND \`status\` = 'active' AND (\`handle\` LIKE ? OR \`display_name\` LIKE ?)${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
});

/**
 * Is this account one the caller may post as?
 *
 * Exported for the social apps: a post carries an `account_id` the client chose, and nothing
 * about that payload proves the account belongs to the session that sent it (§2.9). Every app
 * accepting an `account_id` calls this first.
 *
 * Returns the account rather than a boolean, because the caller almost always needs the handle
 * next and a second read would be wasted.
 */
export async function ownedAccount(
  accountId: unknown,
  citizenid: string,
  appId: string
): Promise<Account | null> {
  let id: number;
  try {
    id = requirePositiveInt(accountId, 'account id');
  } catch {
    return null;
  }

  return await Database.single<Account>(
    `SELECT * FROM \`gphone_accounts\`
     WHERE \`id\` = ? AND \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'
     LIMIT 1`,
    [id, citizenid, appId]
  );
}
