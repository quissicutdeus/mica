// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService, SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { isReactableTable } from '../lib/reactions';
import { Account } from '@gphone/shared/types';
import { pageBounds, requirePositiveInt } from '../lib/payload';
import { accountsContract } from '@gphone/shared/contracts/accounts';
import { buildDeepLink } from '@gphone/shared/deepLink';

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
/**
 * The per-app cap, as a predicate on the insert. MICA-132.
 *
 * `UNIQUE KEY app_handle` enforces **which** handle is taken and nothing enforces **how
 * many** one citizenid holds, so counting first and inserting afterwards was two statements
 * with a yield between them: N concurrent creates with N distinct handles each counted
 * `limit - 1` held, each passed, and each inserted. The rate limiter does not close that —
 * it bounds arrival, not concurrency, so sixty calls a minute permits sixty at once.
 *
 * This is the sharpest of the sites in that ticket because the cap is the only thing
 * rationing a **shared social handle namespace**: without it, one player squats as many
 * handles as they can issue requests for.
 *
 * `COUNT(*)` in a derived table, `INSERT` only if it is still under the ceiling. The handle
 * race is untouched and still belongs to the unique index — the two guard different things
 * and the index remains the better instrument for its one.
 */
class AccountRepository extends SchemaRepository<Account> {
  async createWithinCap(account: Partial<Account>, limit: number): Promise<number> {
    const columns = Object.keys(account);
    // Built here rather than by `super.create`, so the identifier allowlist is this
    // method's own responsibility (§2.9): MySQL cannot parameterize a column name.
    for (const column of columns) {
      if (!this.tableColumns.includes(column)) {
        throw new Error(`[Repository] create on '${this.tableName}' rejected '${column}'.`);
      }
    }

    const columnList = columns.map((column) => `\`${column}\``).join(', ');
    const selection = columns.map(() => '?').join(', ');
    const values = columns.map((column) => (account as Record<string, unknown>)[column]);

    return await Database.insert(
      `INSERT INTO \`${this.tableName}\` (${columnList})
       SELECT ${selection}
       FROM (
         SELECT COUNT(*) AS held FROM \`${this.tableName}\`
         WHERE \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'
       ) AS cap
       WHERE cap.held < ?`,
      [...values, account.citizenid, account.app, limit]
    );
  }
}

export const accounts = defineService<Account, typeof accountsContract>({
  contract: accountsContract,
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
    },
    /**
     * The block graph. Same shape as follows, and for the same reason it lives here rather than
     * on Blabber: blocking is account-to-account, and accounts are shared.
     *
     * One-directional by design: a block hides the blocked account from the *blocker's* feed,
     * Following feed and profile view. The blocked account is unaffected and is never told —
     * there is no "blocked you" state anywhere in this codebase, deliberately, since surfacing
     * one would be a second, larger UX surface than the roadmap item asked for.
     */
    {
      name: 'gphone_account_blocks',
      columns: {
        blocker_account_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_accounts', column: 'id' }
        },
        blocked_account_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_accounts', column: 'id' }
        },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true }
      },
      indexes: [
        {
          name: 'blocker_blocked',
          columns: ['blocker_account_id', 'blocked_account_id'],
          unique: true
        },
        // The reverse lookup every enforcement point needs: "has X blocked me."
        { name: 'blocked_account_id', columns: ['blocked_account_id'] }
      ]
    },
    /**
     * Reactions. Keyed on `account_id` rather than `citizenid`, like every other row here —
     * an account reacts, not a player, and a player may hold several. Declared under Accounts
     * rather than Blabber for the same reason follows and blocks are: reactions are a property
     * of the identity graph, not of one app's content, so a future app that wants them needs
     * only `registerReactable`, not a migration.
     *
     * `target_table`/`target_id` have no foreign key — there is no single parent table a
     * reaction can point at — so `isReactableTable` (`server/lib/reactions.ts`) is what stands
     * between this column and a client naming a table it has no business reacting to.
     */
    {
      name: 'gphone_account_reactions',
      columns: {
        account_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_accounts', column: 'id' }
        },
        target_table: { type: 'string', length: 64, notNull: true },
        target_id: { type: 'int', notNull: true },
        // Free text rather than an enum: the picker offers a fixed palette plus a "+" for any
        // other emoji, so the column has to accept anything the palette does not enumerate.
        emoji: { type: 'string', length: 32, notNull: true },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true }
      },
      indexes: [
        // One reaction per account per emoji per target — tapping the same emoji twice toggles
        // it off rather than stacking a duplicate row.
        {
          name: 'account_target_emoji',
          columns: ['account_id', 'target_table', 'target_id', 'emoji'],
          unique: true
        },
        // The batched read's own lookup: every reaction on a page of targets, one query.
        { name: 'target', columns: ['target_table', 'target_id'] }
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
  },
  repositoryFactory: (resolved: ResolvedService) => new AccountRepository(resolved)
});

const app = accounts.app;
const repo = accounts.repo as AccountRepository;

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
  const appId = data.app;

  const rows = await Database.query<Account[]>(
    `SELECT * FROM \`gphone_accounts\`
     WHERE \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'
     ORDER BY \`id\` ASC`,
    [citizenid, appId]
  );

  return { rows, limit: maxPerApp() };
});

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const appId = data.app;
  // Folded before the pattern is applied, which is why the pattern is not in the contract:
  // refusing a capital the server is about to lowercase anyway would be a worse rule.
  const handle = data.handle.toLowerCase();
  const displayName = data.display_name ?? null;

  if (!HANDLE_PATTERN.test(handle)) {
    throw new PlayerFacingError(
      'A handle is 3–32 characters, using lowercase letters, numbers and _.'
    );
  }

  /**
   * Counted here for the sake of the message, and `createWithinCap` is what actually
   * enforces it — the same division of labour the handle check below has with the unique
   * index, and for the same reason. A count read before an insert cannot hold a cap on its
   * own (MICA-132); what it can do is tell the common case what went wrong in words.
   */
  const limit = maxPerApp();
  const held = await Database.scalar<number>(
    `SELECT COUNT(*) FROM \`gphone_accounts\`
     WHERE \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'`,
    [citizenid, appId]
  );
  if ((held ?? 0) >= limit) {
    throw new PlayerFacingError(
      `You already hold ${limit} accounts here. Delete one to make room.`
    );
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
  if (taken) throw new PlayerFacingError(`@${handle} is taken.`);

  try {
    const id = await repo.createWithinCap(
      { citizenid, app: appId, handle, display_name: displayName },
      limit
    );
    // Zero rows inserted, so no insert id: the cap predicate refused. Reached only when a
    // concurrent create took the last slot between the count above and this statement.
    if (!id) {
      throw new PlayerFacingError(
        `You already hold ${limit} accounts here. Delete one to make room.`
      );
    }
    return { id, citizenid, app: appId, handle, display_name: displayName, status: 'active' };
  } catch (error) {
    // The index did its job in a race. Translate it, because the raw driver error reaches a
    // player's toast and reads as a crash.
    const message = error instanceof Error ? error.message : '';
    if (/duplicate/i.test(message)) {
      // `{ cause }` is the constructor's ES2022 form; this repo's lib target is ES2021, so
      // the property is set directly instead — same effect, portable to the older lib.
      const takenError = new PlayerFacingError(`@${handle} is taken.`);
      (takenError as PlayerFacingError & { cause?: unknown }).cause = error;
      throw takenError;
    }
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
 * The same shape as `blabber:ear`/`unear`, which already got this right: insert-only with the
 * unique index making it idempotent, and a delete scoped to the caller's own account.
 */
app.registerEvent('follow', async (source, cbId, data, citizenid) => {
  const appId = data.app;

  const follower = await ownedAccount(data.follower_account_id, citizenid, appId);
  if (!follower) throw new PlayerFacingError('That account is not yours.');

  const followeeId = data.followee_account_id;

  /**
   * Following yourself is refused rather than stored. It would put your own posts in your
   * Following feed, which already has them nowhere else to be, and inflate both counts by one
   * for everybody.
   */
  if (followeeId === follower.id) throw new PlayerFacingError('You cannot follow yourself.');

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
  if (!followee) throw new PlayerFacingError('That account is no longer available.');

  try {
    await Database.insert(
      'INSERT INTO `gphone_account_follows` (`follower_account_id`, `followee_account_id`) VALUES (?, ?)',
      [follower.id, followee.id]
    );

    // Suppressed when the followee has blocked the follower — a block is meant to end contact,
    // and a "they followed you" toast is exactly the kind of contact it exists to prevent.
    if (!(await accountHasBlocked(followee.id, follower.id))) {
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
    }
  } catch (error) {
    // The unique index refusing a duplicate. Reported as success: from the player's point of
    // view the follow is exactly as applied as they wanted.
    const message = error instanceof Error ? error.message : '';
    if (!/duplicate/i.test(message)) throw error;
  }
  return true;
});

app.registerEvent('unfollow', async (source, cbId, data, citizenid) => {
  const follower = await ownedAccount(data.follower_account_id, citizenid, data.app);
  if (!follower) throw new PlayerFacingError('That account is not yours.');

  const followeeId = data.followee_account_id;

  // Scoped to the caller's own account, so a row id is not authorization to remove somebody
  // else's follow (§2.9).
  await Database.update(
    'DELETE FROM `gphone_account_follows` WHERE `follower_account_id` = ? AND `followee_account_id` = ?',
    [follower.id, followeeId]
  );
  return true;
});

/**
 * Blocking. Same insert-only-with-unique-index shape as `follow`, plus one side effect
 * `follow` does not have: a block cascade-deletes any existing follow row between the two
 * accounts, in **both** directions. A blocked-but-still-following relationship is a state
 * nobody reading a follower list should have to make sense of, and leaving it behind would be
 * cheaper to implement than to explain.
 */
app.registerEvent('block', async (source, cbId, data, citizenid) => {
  const appId = data.app;

  const blocker = await ownedAccount(data.blocker_account_id, citizenid, appId);
  if (!blocker) throw new PlayerFacingError('That account is not yours.');

  const blockedId = data.blocked_account_id;
  if (blockedId === blocker.id) throw new PlayerFacingError('You cannot block yourself.');

  const blocked = await Database.single<{ id: number }>(
    "SELECT `id` FROM `gphone_accounts` WHERE `id` = ? AND `app` = ? AND `status` = 'active' LIMIT 1",
    [blockedId, appId]
  );
  if (!blocked) throw new PlayerFacingError('That account is no longer available.');

  try {
    await Database.insert(
      'INSERT INTO `gphone_account_blocks` (`blocker_account_id`, `blocked_account_id`) VALUES (?, ?)',
      [blocker.id, blocked.id]
    );
  } catch (error) {
    // The unique index refusing a duplicate. Reported as success, same as `follow`.
    const message = error instanceof Error ? error.message : '';
    if (!/duplicate/i.test(message)) throw error;
  }

  await Database.update(
    `DELETE FROM \`gphone_account_follows\`
     WHERE (\`follower_account_id\` = ? AND \`followee_account_id\` = ?)
        OR (\`follower_account_id\` = ? AND \`followee_account_id\` = ?)`,
    [blocker.id, blocked.id, blocked.id, blocker.id]
  );

  return true;
});

app.registerEvent('unblock', async (source, cbId, data, citizenid) => {
  const blocker = await ownedAccount(data.blocker_account_id, citizenid, data.app);
  if (!blocker) throw new PlayerFacingError('That account is not yours.');

  const blockedId = data.blocked_account_id;

  // Scoped to the caller's own account, so a row id is not authorization to lift somebody
  // else's block (§2.9). Unblocking does not restore any follow the block cascade removed.
  await Database.update(
    'DELETE FROM `gphone_account_blocks` WHERE `blocker_account_id` = ? AND `blocked_account_id` = ?',
    [blocker.id, blockedId]
  );
  return true;
});

/**
 * React to a row on any table that opted in via `defineService`'s `reactable`.
 *
 * `target_table` is bound as a value, not interpolated as an identifier, so this is not the
 * SQL-injection boundary `REPORTABLE` is — but an unchecked one would still let a client
 * invent a namespace and pollute counts for a table it has no business reacting to, so
 * `isReactableTable` is checked anyway (§2.9).
 *
 * Insert-only with a unique index, same idempotency shape as `ear`/`follow`/`block`: tapping
 * the same emoji twice is one reaction, not an error.
 */
app.registerEvent('react', async (source, cbId, data, citizenid) => {
  const account = await ownedAccount(data.account_id, citizenid, data.app);
  if (!account) throw new PlayerFacingError('That account is not yours.');

  // Bound as a value by the contract; this is the namespace allowlist, which is a registry
  // apps declare into rather than a list a schema could hold.
  const targetTable = data.target_table;
  if (!isReactableTable(targetTable)) throw new PlayerFacingError('That cannot be reacted to.');
  const targetId = data.target_id;

  try {
    await Database.insert(
      `INSERT INTO \`gphone_account_reactions\`
       (\`account_id\`, \`target_table\`, \`target_id\`, \`emoji\`) VALUES (?, ?, ?, ?)`,
      [account.id, targetTable, targetId, data.emoji]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/duplicate/i.test(message)) throw error;
  }
  return true;
});

app.registerEvent('unreact', async (source, cbId, data, citizenid) => {
  const account = await ownedAccount(data.account_id, citizenid, data.app);
  if (!account) throw new PlayerFacingError('That account is not yours.');

  const targetTable = data.target_table;
  if (!isReactableTable(targetTable)) throw new PlayerFacingError('That cannot be reacted to.');
  const targetId = data.target_id;

  // Scoped to the caller's own account, so a row id is not authorization to remove somebody
  // else's reaction (§2.9).
  await Database.update(
    `DELETE FROM \`gphone_account_reactions\`
     WHERE \`account_id\` = ? AND \`target_table\` = ? AND \`target_id\` = ? AND \`emoji\` = ?`,
    [account.id, targetTable, targetId, data.emoji]
  );
  return true;
});

/**
 * Grouped reaction counts for a page of targets on one table, plus which of the caller's own
 * accounts have used which emoji — mirrors `blabber:engagement`'s batched shape, one call per
 * page of messages rather than one per row.
 */
app.registerEvent('reactionsFor', async (source, cbId, data, citizenid) => {
  const appId = data.app;

  const targetTable = data.target_table;
  if (!isReactableTable(targetTable)) throw new PlayerFacingError('That cannot be reacted to.');

  // Deduplicated rather than trimmed: the contract bounds the count, and a repeated id would
  // otherwise add a placeholder and a bind parameter for a row already named.
  const targetIds = [...new Set(data.target_ids)];

  if (targetIds.length === 0) return {};

  const placeholders = targetIds.map(() => '?').join(', ');
  const [counts, mine] = await Promise.all([
    Database.query<{ target_id: number; emoji: string; total: number }[]>(
      `SELECT \`target_id\`, \`emoji\`, COUNT(*) AS total FROM \`gphone_account_reactions\`
       WHERE \`target_table\` = ? AND \`target_id\` IN (${placeholders})
       GROUP BY \`target_id\`, \`emoji\``,
      [targetTable, ...targetIds]
    ),
    (async () => {
      const mineAccounts = await Database.query<{ id: number }[]>(
        "SELECT `id` FROM `gphone_accounts` WHERE `citizenid` = ? AND `app` = ? AND `status` = 'active'",
        [citizenid, appId]
      );
      const myIds = mineAccounts.map((row) => row.id);
      if (myIds.length === 0) return [];
      return await Database.query<{ target_id: number; emoji: string }[]>(
        `SELECT \`target_id\`, \`emoji\` FROM \`gphone_account_reactions\`
         WHERE \`target_table\` = ? AND \`target_id\` IN (${placeholders})
         AND \`account_id\` IN (${myIds.map(() => '?').join(', ')})`,
        [targetTable, ...targetIds, ...myIds]
      );
    })()
  ]);

  const out: Record<number, { counts: Record<string, number>; mine: string[] }> = {};
  for (const id of targetIds) out[id] = { counts: {}, mine: [] };
  for (const row of counts) {
    out[row.target_id].counts[row.emoji] = Number(row.total);
  }
  for (const row of mine) {
    out[row.target_id].mine.push(row.emoji);
  }
  return out;
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
  const appId = data.app;
  const accountId = data.account_id;

  const viewer =
    data.viewer_account_id === undefined || data.viewer_account_id === null
      ? null
      : await ownedAccount(data.viewer_account_id, citizenid, appId);

  const [followers, following, mine, blocked] = await Promise.all([
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
      : Promise.resolve(null),
    // Same "absent viewer answers false" rule as `followedByMe` — reading a profile is not a
    // privileged act, and only the Block button needs an identity.
    viewer ? accountHasBlocked(viewer.id, accountId) : Promise.resolve(false)
  ]);

  return {
    followers: followers ?? 0,
    following: following ?? 0,
    followedByMe: mine !== null,
    blockedByMe: blocked
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
  data: { app: string; account_id: number; cursor?: number | null; limit?: number },
  direction: 'followers' | 'following'
): Promise<{ rows: Account[]; nextCursor: number | null }> => {
  const appId = data.app;
  const accountId = data.account_id;
  const { limit, cursor } = pageBounds(data, paging);

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
    rows: page.map(({ cursor_id: _cursor_id, ...account }) => account as Account),
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
  const appId = data.app;

  const q = data.q;
  const { limit, cursor } = pageBounds(data, paging);

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

/**
 * Has `blockerAccountId` blocked `blockedAccountId`?
 *
 * Exported for the same reason `ownedAccount` is: every enforcement point that needs to check
 * a block — feed filtering, notification suppression, DM refusal — lives in a different
 * service file, and the block graph is this service's table.
 *
 * **Named for the identity it asks about, because there is a second block graph.**
 * `Blocklist.ts` exports an `isBlocked` too, over `gphone_blocklist`, and it takes a
 * `(citizenid, phone number)` — a different table, a different question, and the same word.
 * Both were imported under that bare name in different files (`Phone.ts` reached for one and
 * `Blabber.ts` for the other), so a reader had to check the import line to know which graph a
 * call site was consulting, and an editor moving code between the two files would have
 * compiled against the wrong one without a type error: `number` and `string` are only two
 * arguments apart. `accountHasBlocked` says which identity it is about in its own name
 * (MICA-197).
 */
export async function accountHasBlocked(
  blockerAccountId: number,
  blockedAccountId: number
): Promise<boolean> {
  const row = await Database.single<{ id: number }>(
    `SELECT \`id\` FROM \`gphone_account_blocks\`
     WHERE \`blocker_account_id\` = ? AND \`blocked_account_id\` = ? LIMIT 1`,
    [blockerAccountId, blockedAccountId]
  );
  return row !== null;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Reading accounts, for the apps built on them (MICA-197)
 *
 * `gphone_accounts` is this service's table and three other services were querying it by
 * hand: `Blabber.ts` twice, `BlabberDms.ts` three times, each with its own spelling of the
 * same `app = ? AND status = 'active'` predicate. That is the shape AGENTS.md §10 forbids
 * across *resources* — never read another resource's tables — applied one level in: a
 * predicate copied five times is five places for it to stop agreeing, and "active" is the
 * one that decides whether a deleted account can still be messaged.
 *
 * `ownedAccount` above is the authorization question and stays separate. These are the
 * lookups that follow it.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * What a resolver hands back.
 *
 * Deliberately not `SELECT *`: `avatar` and `bio` are profile *content*, sometimes a base64
 * image, and every caller here is asking who an account is rather than what it looks like.
 * The DM inbox resolves up to fifty peers at once and drew avatars it never rendered.
 */
const ACCOUNT_IDENTITY = '`id`, `citizenid`, `app`, `handle`, `display_name`, `status`';

/**
 * An account as a resolver returns it.
 *
 * `Account.citizenid` is optional because a **public** projection withholds it — that is the
 * de-anonymisation rule this table exists under, and `publicColumns` enforces it. These
 * resolvers are the server-side path and select it explicitly, so it is always there, and
 * saying so is what lets a caller use it without a non-null assertion that would be a lie if
 * the projection ever changed.
 */
export type AccountIdentity = Account & { citizenid: string };

/**
 * The most accounts one resolver call may name.
 *
 * The ids and handles reaching these come from a client payload or from a row count the
 * client can influence, and an unbounded `IN` list is both an injection-shaped risk and a way
 * to ask for one enormous query (§2.9). Callers already cap their own lists; this caps them
 * again, on `orphanSweep.ts`'s principle that a guard living only at the producer stops
 * guarding the moment a second producer appears.
 */
const MAX_ACCOUNT_BATCH = 100;

/** Every active account this player holds in one app. The set they may act as. */
export async function accountsOwnedBy(
  citizenid: string,
  appId: string
): Promise<AccountIdentity[]> {
  if (!citizenid || !appId) return [];

  return await Database.query<AccountIdentity[]>(
    `SELECT ${ACCOUNT_IDENTITY} FROM \`gphone_accounts\`
     WHERE \`citizenid\` = ? AND \`app\` = ? AND \`status\` = 'active'
     ORDER BY \`id\` ASC`,
    [citizenid, appId]
  );
}

/**
 * The accounts behind a list of handles, within one app.
 *
 * Handles are deduplicated and lowercased first: they are stored lowercase (`create` does the
 * same), so a mention written `@Ada` has to find `ada` rather than silently matching nothing.
 */
export async function accountsByHandle(
  handles: readonly string[],
  appId: string
): Promise<AccountIdentity[]> {
  if (!appId) return [];

  const wanted = [...new Set(handles.filter(Boolean).map((handle) => handle.toLowerCase()))].slice(
    0,
    MAX_ACCOUNT_BATCH
  );
  if (wanted.length === 0) return [];

  const placeholders = wanted.map(() => '?').join(', ');
  return await Database.query<AccountIdentity[]>(
    `SELECT ${ACCOUNT_IDENTITY} FROM \`gphone_accounts\`
     WHERE \`app\` = ? AND \`status\` = 'active' AND \`handle\` IN (${placeholders})`,
    [appId, ...wanted]
  );
}

/**
 * The accounts behind a list of ids, whatever app and status they are in.
 *
 * **Not filtered to `active`, deliberately.** The one caller is the DM inbox, which renders a
 * handle beside a thread that already exists; hiding a deleted correspondent's handle would
 * leave a row of messages attributed to nobody rather than protecting anything, since the
 * messages themselves are the caller's own and already readable. A caller that needs the
 * account to still be usable wants `activeAccount` below, which is the authorization-shaped
 * one.
 */
export async function accountsByIds(ids: readonly number[]): Promise<AccountIdentity[]> {
  const wanted = [...new Set(ids)].filter(Number.isInteger).slice(0, MAX_ACCOUNT_BATCH);
  if (wanted.length === 0) return [];

  const placeholders = wanted.map(() => '?').join(', ');
  return await Database.query<AccountIdentity[]>(
    `SELECT ${ACCOUNT_IDENTITY} FROM \`gphone_accounts\`
     WHERE \`id\` IN (${placeholders})`,
    wanted
  );
}

/**
 * One account, if it exists, is active, and belongs to this app.
 *
 * The check a client-chosen `account_id` needs before it becomes the other end of anything:
 * an unchecked one writes a row pointing at nothing, or at an account in another app's
 * namespace — which is the only thing keeping two apps' identity graphs apart.
 *
 * This is *not* an ownership check. `ownedAccount` is, and a caller acting **as** an account
 * wants that one.
 */
export async function activeAccount(
  accountId: number,
  appId: string
): Promise<AccountIdentity | null> {
  if (!Number.isInteger(accountId) || accountId <= 0 || !appId) return null;

  return await Database.single<AccountIdentity>(
    `SELECT ${ACCOUNT_IDENTITY} FROM \`gphone_accounts\`
     WHERE \`id\` = ? AND \`app\` = ? AND \`status\` = 'active' LIMIT 1`,
    [accountId, appId]
  );
}
